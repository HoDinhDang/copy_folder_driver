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

// Tự động xác định Redirect URI từ request (hỗ trợ cả localhost và Render/Cloud)
function getRedirectUriFromReq(req) {
  if (!req) return null;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}/api/auth/google/callback`;
}

// Lấy OAuth2 Client
function getOAuth2Client(req = null) {
  const config = loadJson(CONFIG_FILE, {});
  const clientId = process.env.GOOGLE_CLIENT_ID || config.clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || config.clientSecret;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    getRedirectUriFromReq(req) ||
    config.redirectUri ||
    `http://localhost:${PORT}/api/auth/google/callback`;

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

// Gọi API cho các thao tác đọc/tạo thư mục (retry nhanh nếu lỗi mạng/rate-limit ngắn)
async function driveApiCall(apiFn, { maxRetries = 3, jobId = null, actionName = '' } = {}) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await apiFn();
    } catch (err) {
      attempt++;
      const isTransient = err.code === 429 || err.code === 500 || err.code === 503;
      if (isTransient && attempt < maxRetries) {
        const delay = 2000 * attempt;
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// Hàm copy 1 file thông minh với 3 cơ chế dự phòng (Không bị treo chờ lâu trên 1 file bị khóa)
async function smartCopySingleFile(drive, item, dstFolderId, jobId) {
  const quotaUser = `user_${jobId.slice(0, 16)}`;
  const errors = [];

  // Cơ chế 1: Server-side Copy trực tiếp (Nhanh nhất)
  try {
    await drive.files.copy({
      fileId: item.id,
      quotaUser,
      supportsAllDrives: true,
      requestBody: {
        name: item.name,
        parents: [dstFolderId]
      },
      fields: 'id, name, size'
    });
    return { method: 'Direct Copy' };
  } catch (err1) {
    const reason1 = err1?.errors?.[0]?.reason || err1.code || 'unknown';
    errors.push(`Copy(${reason1}): ${err1.message}`);
  }

  // Cơ chế 2: Stream Download -> Upload (Vượt qua giới hạn files.copy của Google)
  const isGoogleNativeApp = item.mimeType && item.mimeType.startsWith('application/vnd.google-apps.');
  if (!isGoogleNativeApp) {
    try {
      const streamRes = await drive.files.get(
        {
          fileId: item.id,
          alt: 'media',
          acknowledgeAbuse: true,
          supportsAllDrives: true,
          quotaUser
        },
        { responseType: 'stream' }
      );

      await drive.files.create({
        quotaUser,
        supportsAllDrives: true,
        requestBody: {
          name: item.name,
          parents: [dstFolderId]
        },
        media: {
          mimeType: item.mimeType || 'application/octet-stream',
          body: streamRes.data
        },
        fields: 'id'
      });
      return { method: 'Stream Copy' };
    } catch (err2) {
      const reason2 = err2?.errors?.[0]?.reason || err2.code || 'unknown';
      errors.push(`Stream(${reason2}): ${err2.message}`);
    }
  }

  // Cơ chế 3: Nếu là file Office (.xlsx, .docx, .pptx) bị khóa tải binary, thử convert sang Google Sheets/Docs khi copy
  const lowerName = (item.name || '').toLowerCase();
  let convertMime = null;
  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.csv')) {
    convertMime = 'application/vnd.google-apps.spreadsheet';
  } else if (lowerName.endsWith('.docx') || lowerName.endsWith('.doc')) {
    convertMime = 'application/vnd.google-apps.document';
  } else if (lowerName.endsWith('.pptx') || lowerName.endsWith('.ppt')) {
    convertMime = 'application/vnd.google-apps.presentation';
  }

  if (convertMime) {
    try {
      await drive.files.copy({
        fileId: item.id,
        quotaUser,
        supportsAllDrives: true,
        requestBody: {
          name: item.name,
          mimeType: convertMime,
          parents: [dstFolderId]
        },
        fields: 'id'
      });
      return { method: 'Docs Convert' };
    } catch (err3) {
      const reason3 = err3?.errors?.[0]?.reason || err3.code || 'unknown';
      errors.push(`Convert(${reason3}): ${err3.message}`);
    }
  }

  const finalError = new Error(errors.join(' | '));
  throw finalError;
}

// Escape chuỗi cho query của Google Drive
function escapeDriveQuery(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Lấy danh sách các file/folder đã tồn tại trong thư mục đích để hỗ trợ Resume (chạy tiếp không copy trùng)
async function getExistingChildrenMap(drive, folderId, jobId) {
  const map = new Map(); // name -> { id, mimeType, size }
  let pageToken = null;
  do {
    const res = await driveApiCall(
      () =>
        drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size)',
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        }),
      { jobId }
    );
    for (const f of res.data.files || []) {
      map.set(f.name, f);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return map;
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
    const sourceFolderMeta = await driveApiCall(
      () =>
        drive.files.get({
          fileId: job.sourceFolderId,
          fields: 'id, name, mimeType',
          supportsAllDrives: true
        }),
      { jobId, actionName: 'Lấy thông tin thư mục nguồn' }
    );

    const sourceTitle = sourceFolderMeta.data.name || 'Thư mục không tên';
    addJobLog(jobId, `Đã tìm thấy thư mục nguồn: "${sourceTitle}"`, 'success');

    // 2. Kiểm tra hoặc tạo thư mục gốc đích trên Drive của user (Hỗ trợ chạy tiếp / Resume nếu đã có)
    const targetRootName = job.destFolderName || `[Bản sao] ${sourceTitle}`;
    const targetParent = job.destFolderId || 'root';

    const existingRootCheck = await driveApiCall(
      () =>
        drive.files.list({
          q: `'${targetParent}' in parents and name = '${escapeDriveQuery(targetRootName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id, name, webViewLink)',
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        }),
      { jobId }
    );

    if (existingRootCheck.data.files && existingRootCheck.data.files.length > 0) {
      const existingFolder = existingRootCheck.data.files[0];
      job.destCreatedFolderId = existingFolder.id;
      job.destFolderLink = existingFolder.webViewLink;
      addJobLog(
        jobId,
        `♻️ Phát hiện thư mục đích "${targetRootName}" đã có sẵn. Hệ thống sẽ tự động bỏ qua các file đã copy và chỉ copy bù các file còn thiếu!`,
        'info'
      );
    } else {
      addJobLog(jobId, `Đang tạo thư mục đích "${targetRootName}" trên Drive của bạn...`, 'info');
      const rootFolderCreate = await driveApiCall(
        () =>
          drive.files.create({
            requestBody: {
              name: targetRootName,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [targetParent]
            },
            supportsAllDrives: true,
            fields: 'id, name, webViewLink'
          }),
        { jobId, actionName: 'Tạo thư mục gốc' }
      );
      job.destCreatedFolderId = rootFolderCreate.data.id;
      job.destFolderLink = rootFolderCreate.data.webViewLink;
      addJobLog(jobId, `Thư mục đích đã tạo thành công! ID: ${rootFolderCreate.data.id}`, 'success');
    }
    broadcastJobUpdate(jobId);

    // 3. Hàm đệ quy duyệt và copy
    async function copyDirectoryRecursive(srcFolderId, dstFolderId, currentPath = '') {
      if (job.status === 'cancelled') {
        throw new Error('Tiến trình đã bị người dùng hủy!');
      }

      // Lấy danh sách file/folder đã có trong thư mục đích này để tránh copy lại file đã có
      const existingChildren = await getExistingChildrenMap(drive, dstFolderId, jobId);

      let pageToken = null;
      do {
        const res = await driveApiCall(
          () =>
            drive.files.list({
              q: `'${srcFolderId}' in parents and trashed = false`,
              orderBy: 'folder,name',
              fields: 'nextPageToken, files(id, name, mimeType, size)',
              pageSize: 100,
              pageToken: pageToken,
              supportsAllDrives: true,
              includeItemsFromAllDrives: true
            }),
          { jobId }
        );

        const items = res.data.files || [];

        for (const item of items) {
          if (job.status === 'cancelled') {
            throw new Error('Tiến trình đã bị người dùng hủy!');
          }

          const itemPath = currentPath ? `${currentPath}/${item.name}` : item.name;

          if (item.mimeType === 'application/vnd.google-apps.folder') {
            // Kiểm tra xem thư mục con đã tồn tại chưa
            let targetSubFolderId = null;
            const existingSub = existingChildren.get(item.name);
            if (existingSub && existingSub.mimeType === 'application/vnd.google-apps.folder') {
              targetSubFolderId = existingSub.id;
              addJobLog(jobId, `[Thư mục] Đã có sẵn, duyệt tiếp: ${itemPath}`, 'info');
            } else {
              addJobLog(jobId, `[Thư mục] Tạo: ${itemPath}`, 'info');
              const newFolder = await driveApiCall(
                () =>
                  drive.files.create({
                    requestBody: {
                      name: item.name,
                      mimeType: 'application/vnd.google-apps.folder',
                      parents: [dstFolderId]
                    },
                    supportsAllDrives: true,
                    fields: 'id'
                  }),
                { jobId, actionName: item.name }
              );
              targetSubFolderId = newFolder.data.id;
              job.stats.totalFolders++;
              broadcastJobUpdate(jobId);
              await sleep(400);
            }

            // Đệ quy vào thư mục con này
            await copyDirectoryRecursive(item.id, targetSubFolderId, itemPath);
          } else {
            // Kiểm tra nếu file đã được copy trước đó rồi thì bỏ qua
            const existingFile = existingChildren.get(item.name);
            if (existingFile && existingFile.mimeType !== 'application/vnd.google-apps.folder') {
              job.stats.copiedFiles++;
              if (item.size) {
                job.stats.copiedBytes += parseInt(item.size, 10) || 0;
              }
              addJobLog(jobId, `⏭️ Đã tồn tại, bỏ qua: ${item.name}`, 'info');
              broadcastJobUpdate(jobId);
              continue;
            }

            // Là tập tin -> Gọi smartCopySingleFile (thử 3 cơ chế: Direct Copy -> Stream -> Docs Convert)
            addJobLog(jobId, `[Copying] ${itemPath}...`, 'info');
            try {
              const copyRes = await smartCopySingleFile(drive, item, dstFolderId, jobId);
              job.stats.copiedFiles++;
              if (item.size) {
                job.stats.copiedBytes += parseInt(item.size, 10) || 0;
              }
              addJobLog(jobId, `✓ Đã copy (${copyRes.method}): ${item.name}`, 'success');
            } catch (copyErr) {
              job.stats.failedFiles++;
              addJobLog(
                jobId,
                `✗ Bỏ qua file bị Google khóa tải 24h (${item.name}): ${copyErr.message}`,
                'error'
              );
            }

            broadcastJobUpdate(jobId);
            await sleep(800);
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
  const expectedRedirectUri = process.env.GOOGLE_REDIRECT_URI || getRedirectUriFromReq(req) || config.redirectUri;

  if (!clientId || !clientSecret) {
    return res.json({ configured: false, authenticated: false, redirectUri: expectedRedirectUri });
  }

  if (!tokens) {
    return res.json({ configured: true, authenticated: false, clientId, redirectUri: expectedRedirectUri });
  }

  try {
    const oauth2Client = getOAuth2Client(req);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const about = await drive.about.get({ fields: 'user, storageQuota' });
    return res.json({
      configured: true,
      authenticated: true,
      user: about.data.user,
      storageQuota: about.data.storageQuota,
      redirectUri: expectedRedirectUri
    });
  } catch (err) {
    console.error('Token expired or invalid:', err.message);
    return res.json({ configured: true, authenticated: false, error: err.message, redirectUri: expectedRedirectUri });
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
  const oauth2Client = getOAuth2Client(req);
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
    const oauth2Client = getOAuth2Client(req);
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
