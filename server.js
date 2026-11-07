const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Đảm bảo thư mục lưu trữ dữ liệu tồn tại
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

// Helper load/save JSON
function loadJson(file, defaultVal = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error(`Lỗi đọc file ${file}:`, err.message);
  }
  return defaultVal;
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Lỗi lưu file ${file}:`, err.message);
  }
}

// Lấy OAuth2 Client
function getOAuth2Client() {
  const config = loadJson(CONFIG_FILE, {});
  const clientId = process.env.GOOGLE_CLIENT_ID || config.clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || config.clientSecret;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || config.redirectUri || `http://localhost:${PORT}/api/auth/google/callback`;

  if (!clientId || !clientSecret) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const tokens = loadJson(TOKENS_FILE, null);
  if (tokens) {
    oauth2Client.setCredentials(tokens);
  }
  return oauth2Client;
}

// Quản lý Jobs
const jobs = loadJson(JOBS_FILE, {});
const activeEventClients = new Map(); // jobId -> Set of express res objects

function broadcastJobUpdate(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  saveJson(JOBS_FILE, jobs);

  const clients = activeEventClients.get(jobId);
  if (clients) {
    const payload = `data: ${JSON.stringify(job)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch (e) {
        clients.delete(res);
      }
    }
  }
}

function addJobLog(jobId, message, type = 'info') {
  const job = jobs[jobId];
  if (!job) return;
  const timestamp = new Date().toLocaleTimeString('vi-VN');
  const entry = { time: timestamp, message, type };
  job.logs.push(entry);
  if (job.logs.length > 500) job.logs.shift(); // giới hạn 500 dòng log gần nhất
  broadcastJobUpdate(jobId);
}

// Trích xuất Folder ID từ link Drive
function extractFolderId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  // Khớp link google drive dạng /folders/<id>
  const folderMatch = trimmed.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];

  // Khớp dạng ?id=<id>
  const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];

  // Nếu là ID trực tiếp (chỉ chứa ký tự an toàn dài > 20)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

// Delay helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gọi API có exponential backoff tránh vượt quota 10 request/giây của Google Drive
async function driveApiCall(apiFn, maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await apiFn();
    } catch (err) {
      attempt++;
      const isRateLimit = err.code === 403 || err.code === 429 || err.code === 500 || err.code === 503;
      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 800 + Math.random() * 500;
        console.warn(`Drive API rate-limited, thử lại lần ${attempt} sau ${Math.round(delay)}ms...`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// Tiến trình copy chạy nền (Background Worker)
async function startCopyWorker(jobId) {
  const job = jobs[jobId];
  if (!job) return;

  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    job.status = 'failed';
    job.error = 'Chưa xác thực Google Drive!';
    addJobLog(jobId, 'Lỗi: Chưa kết nối tài khoản Google Drive.', 'error');
    broadcastJobUpdate(jobId);
    return;
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    addJobLog(jobId, `Bắt đầu quét thư mục nguồn ID: ${job.sourceFolderId}...`, 'info');
    broadcastJobUpdate(jobId);

    // 1. Lấy thông tin thư mục nguồn
    const sourceFolderMeta = await driveApiCall(() =>
      drive.files.get({
        fileId: job.sourceFolderId,
        fields: 'id, name, mimeType',
        supportsAllDrives: true
      })
    );

    const sourceTitle = sourceFolderMeta.data.name || 'Thư mục không tên';
    addJobLog(jobId, `Đã tìm thấy thư mục nguồn: "${sourceTitle}"`, 'success');

    // 2. Tạo thư mục gốc đích trên Drive của user
    const targetRootName = job.destFolderName || `[Bản sao] ${sourceTitle}`;
    const targetParent = job.destFolderId || 'root';

    addJobLog(jobId, `Đang tạo thư mục đích "${targetRootName}" trên Drive của bạn...`, 'info');
    const rootFolderCreate = await driveApiCall(() =>
      drive.files.create({
        requestBody: {
          name: targetRootName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [targetParent]
        },
        supportsAllDrives: true,
        fields: 'id, name, webViewLink'
      })
    );

    job.destCreatedFolderId = rootFolderCreate.data.id;
    job.destFolderLink = rootFolderCreate.data.webViewLink;
    addJobLog(jobId, `Thư mục đích đã tạo thành công! ID: ${rootFolderCreate.data.id}`, 'success');
    broadcastJobUpdate(jobId);

    // 3. Hàm đệ quy duyệt và copy
    async function copyDirectoryRecursive(srcFolderId, dstFolderId, currentPath = '') {
      if (job.status === 'cancelled') {
        throw new Error('Tiến trình đã bị người dùng hủy!');
      }

      let pageToken = null;
      do {
        const res = await driveApiCall(() =>
          drive.files.list({
            q: `'${srcFolderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, size)',
            pageSize: 100,
            pageToken: pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
          })
        );

        const items = res.data.files || [];

        for (const item of items) {
          if (job.status === 'cancelled') {
            throw new Error('Tiến trình đã bị người dùng hủy!');
          }

          const itemPath = currentPath ? `${currentPath}/${item.name}` : item.name;

          if (item.mimeType === 'application/vnd.google-apps.folder') {
            // Là thư mục con -> tạo thư mục trên Drive đích
            addJobLog(jobId, `[Thư mục] Tạo: ${itemPath}`, 'info');
            const newFolder = await driveApiCall(() =>
              drive.files.create({
                requestBody: {
                  name: item.name,
                  mimeType: 'application/vnd.google-apps.folder',
                  parents: [dstFolderId]
                },
                supportsAllDrives: true,
                fields: 'id'
              })
            );
            job.stats.totalFolders++;
            broadcastJobUpdate(jobId);

            // Đệ quy vào thư mục con này
            await copyDirectoryRecursive(item.id, newFolder.data.id, itemPath);
          } else {
            // Là tập tin -> Sử dụng files.copy (server-side copy trực tiếp của Google)
            addJobLog(jobId, `[Copying] ${itemPath}...`, 'info');
            try {
              await driveApiCall(() =>
                drive.files.copy({
                  fileId: item.id,
                  requestBody: {
                    name: item.name,
                    parents: [dstFolderId]
                  },
                  supportsAllDrives: true,
                  fields: 'id, name, size'
                })
              );

              job.stats.copiedFiles++;
              if (item.size) {
                job.stats.copiedBytes += parseInt(item.size, 10) || 0;
              }
              addJobLog(jobId, `✓ Đã copy: ${item.name}`, 'success');
            } catch (copyErr) {
              job.stats.failedFiles++;
              addJobLog(jobId, `✗ Lỗi copy file ${item.name}: ${copyErr.message}`, 'error');
            }

            broadcastJobUpdate(jobId);
            // Delay nhẹ 150ms để tôn trọng quota API
            await sleep(150);
          }
        }

        pageToken = res.data.nextPageToken;
      } while (pageToken);
    }

    // Thực hiện copy từ root
    await copyDirectoryRecursive(job.sourceFolderId, job.destCreatedFolderId);

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    addJobLog(jobId, `🎉 Hoàn thành xuất sắc! Đã copy ${job.stats.copiedFiles} files vào Drive của bạn.`, 'success');
    broadcastJobUpdate(jobId);
  } catch (err) {
    if (job.status === 'cancelled') {
      addJobLog(jobId, 'Tiến trình đã dừng theo yêu cầu của bạn.', 'warning');
    } else {
      job.status = 'failed';
      job.error = err.message;
      addJobLog(jobId, `Lỗi nghiêm trọng: ${err.message}`, 'error');
    }
    broadcastJobUpdate(jobId);
  }
}

// =================== ROUTES & API ===================

// Trạng thái cấu hình & xác thực
app.get('/api/auth/status', async (req, res) => {
  const config = loadJson(CONFIG_FILE, {});
  const tokens = loadJson(TOKENS_FILE, null);
  const clientId = process.env.GOOGLE_CLIENT_ID || config.clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || config.clientSecret;

  if (!clientId || !clientSecret) {
    return res.json({ configured: false, authenticated: false });
  }

  if (!tokens) {
    return res.json({ configured: true, authenticated: false, clientId });
  }

  try {
    const oauth2Client = getOAuth2Client();
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const about = await drive.about.get({ fields: 'user, storageQuota' });
    return res.json({
      configured: true,
      authenticated: true,
      user: about.data.user,
      storageQuota: about.data.storageQuota
    });
  } catch (err) {
    console.error('Token expired or invalid:', err.message);
    return res.json({ configured: true, authenticated: false, error: err.message });
  }
});

// Lưu thông tin Google OAuth Client ID / Secret từ Web UI
app.post('/api/auth/save-credentials', (req, res) => {
  const { clientId, clientSecret, redirectUri } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Client ID và Client Secret không được để trống' });
  }

  const config = loadJson(CONFIG_FILE, {});
  config.clientId = clientId.trim();
  config.clientSecret = clientSecret.trim();
  if (redirectUri) {
    config.redirectUri = redirectUri.trim();
  }
  saveJson(CONFIG_FILE, config);

  res.json({ success: true, message: 'Đã lưu thông tin cấu hình Google OAuth thành công!' });
});

// Chuyển hướng đăng nhập Google OAuth 2.0
app.get('/api/auth/google', (req, res) => {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    return res.status(400).send('Chưa cấu hình Google Client ID và Client Secret. Vui lòng thiết lập trên giao diện trước!');
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]
  });

  res.redirect(authUrl);
});

// Callback nhận token từ Google
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.send(`Lỗi đăng nhập: ${error}. <a href="/">Quay lại trang chủ</a>`);
  }
  if (!code) {
    return res.status(400).send('Không nhận được authorization code từ Google.');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    saveJson(TOKENS_FILE, tokens);
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Lỗi lấy token:', err);
    res.status(500).send(`Lỗi xác thực: ${err.message}. <a href="/">Thử lại</a>`);
  }
});

// Đăng xuất Google
app.post('/api/auth/logout', (req, res) => {
  if (fs.existsSync(TOKENS_FILE)) {
    fs.unlinkSync(TOKENS_FILE);
  }
  res.json({ success: true, message: 'Đã ngắt kết nối tài khoản Google.' });
});

// Tạo Job Copy mới
app.post('/api/jobs', (req, res) => {
  const { sourceUrlOrId, destFolderId, destFolderName } = req.body;

  const folderId = extractFolderId(sourceUrlOrId);
  if (!folderId) {
    return res.status(400).json({ error: 'Không nhận diện được link hoặc ID thư mục nguồn hợp lệ.' });
  }

  const jobId = uuidv4();
  const newJob = {
    id: jobId,
    sourceFolderId: folderId,
    sourceUrlOrId,
    destFolderId: destFolderId ? destFolderId.trim() : null,
    destFolderName: destFolderName ? destFolderName.trim() : null,
    destCreatedFolderId: null,
    destFolderLink: null,
    status: 'pending', // pending, running, completed, failed, cancelled
    stats: {
      totalFolders: 0,
      copiedFiles: 0,
      failedFiles: 0,
      copiedBytes: 0
    },
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    logs: []
  };

  jobs[jobId] = newJob;
  saveJson(JOBS_FILE, jobs);

  // Bắt đầu chạy ngầm worker
  startCopyWorker(jobId);

  res.json({ success: true, job: newJob });
});

// Lấy danh sách jobs
app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Lấy chi tiết 1 job
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: 'Không tìm thấy job' });
  }
  res.json(job);
});

// Hủy job
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: 'Không tìm thấy job' });
  }
  if (job.status === 'running' || job.status === 'pending') {
    job.status = 'cancelled';
    broadcastJobUpdate(req.params.id);
    return res.json({ success: true, message: 'Đã gửi yêu cầu hủy copy.' });
  }
  res.json({ success: false, message: 'Job không ở trạng thái đang chạy.' });
});

// Server-Sent Events (SSE) để truyền logs & tiến độ realtime
app.get('/api/jobs/:id/events', (req, res) => {
  const jobId = req.params.id;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).send('Job not found');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!activeEventClients.has(jobId)) {
    activeEventClients.set(jobId, new Set());
  }
  activeEventClients.get(jobId).add(res);

  // Gửi trạng thái ban đầu
  res.write(`data: ${JSON.stringify(job)}\n\n`);

  req.on('close', () => {
    const clients = activeEventClients.get(jobId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        activeEventClients.delete(jobId);
      }
    }
  });
});

// Tự động kiểm tra tiếp tục các job bị ngắt giữa chừng khi server khởi động lại
Object.values(jobs).forEach((j) => {
  if (j.status === 'running') {
    j.status = 'failed';
    j.error = 'Máy chủ đã được khởi động lại trong khi đang chạy copy.';
    j.logs.push({
      time: new Date().toLocaleTimeString('vi-VN'),
      message: 'Máy chủ vừa khởi động lại. Vui lòng tạo tiến trình mới nếu cần tiếp tục.',
      type: 'warning'
    });
  }
});
saveJson(JOBS_FILE, jobs);

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Drive Copier Web App đang chạy tại: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
