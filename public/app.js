// State
let currentJobId = null;
let currentEventSource = null;
let isAuthenticated = false;

// DOM Elements
const authStatusBox = document.getElementById('authStatusBox');
const authTitle = document.getElementById('authTitle');
const authDesc = document.getElementById('authDesc');
const btnConnectGoogle = document.getElementById('btnConnectGoogle');
const btnLogoutGoogle = document.getElementById('btnLogoutGoogle');

const copyForm = document.getElementById('copyForm');
const sourceUrlInput = document.getElementById('sourceUrl');
const destFolderNameInput = document.getElementById('destFolderName');
const destFolderIdInput = document.getElementById('destFolderId');
const btnStartCopy = document.getElementById('btnStartCopy');

const noJobPlaceholder = document.getElementById('noJobPlaceholder');
const activeJobContainer = document.getElementById('activeJobContainer');
const jobBadgeStatus = document.getElementById('jobBadgeStatus');
const statFiles = document.getElementById('statFiles');
const statFolders = document.getElementById('statFolders');
const statSize = document.getElementById('statSize');
const statErrors = document.getElementById('statErrors');
const logContainer = document.getElementById('logContainer');
const btnClearLog = document.getElementById('btnClearLog');
const btnCancelJob = document.getElementById('btnCancelJob');
const btnOpenTargetDrive = document.getElementById('btnOpenTargetDrive');

const jobsTableBody = document.getElementById('jobsTableBody');
const btnRefreshJobs = document.getElementById('btnRefreshJobs');

// Modal Elements
const modalSettings = document.getElementById('modalSettings');
const btnOpenSettings = document.getElementById('btnOpenSettings');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnSaveConfig = document.getElementById('btnSaveConfig');
const cfgClientId = document.getElementById('cfgClientId');
const cfgClientSecret = document.getElementById('cfgClientSecret');
const currentRedirectUri = document.getElementById('currentRedirectUri');

const modalDocs = document.getElementById('modalDocs');
const btnOpenDocs = document.getElementById('btnOpenDocs');
const btnCloseDocs = document.getElementById('btnCloseDocs');

// Utility: format bytes
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Lưu & khôi phục các ô nhập trên giao diện qua localStorage
function saveFormToLocal() {
  try {
    localStorage.setItem('dc_sourceUrl', sourceUrlInput.value);
    localStorage.setItem('dc_destFolderName', destFolderNameInput.value);
    localStorage.setItem('dc_destFolderId', destFolderIdInput.value);
  } catch (e) {}
}

function restoreFormFromLocal() {
  try {
    const sUrl = localStorage.getItem('dc_sourceUrl');
    const dName = localStorage.getItem('dc_destFolderName');
    const dId = localStorage.getItem('dc_destFolderId');
    if (sUrl !== null && sUrl !== '') sourceUrlInput.value = sUrl;
    if (dName !== null) destFolderNameInput.value = dName;
    if (dId !== null) destFolderIdInput.value = dId;

    const savedClientId = localStorage.getItem('dc_clientId');
    const savedClientSecret = localStorage.getItem('dc_clientSecret');
    if (savedClientId) cfgClientId.value = savedClientId;
    if (savedClientSecret) cfgClientSecret.value = savedClientSecret;
  } catch (e) {}
}

sourceUrlInput.addEventListener('input', saveFormToLocal);
destFolderNameInput.addEventListener('input', saveFormToLocal);
destFolderIdInput.addEventListener('input', saveFormToLocal);

// Kiểm tra Auth Status
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();

    if (!data.configured) {
      // Nếu trình duyệt có lưu sẵn Client ID & Secret, tự động đồng bộ lại lên server
      const savedClientId = localStorage.getItem('dc_clientId');
      const savedClientSecret = localStorage.getItem('dc_clientSecret');
      if (savedClientId && savedClientSecret) {
        const redirectUri = `${window.location.origin}/api/auth/google/callback`;
        await fetch('/api/auth/save-credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: savedClientId, clientSecret: savedClientSecret, redirectUri })
        });
        return checkAuthStatus();
      }

      authStatusBox.className = 'status-box not-connected';
      authTitle.textContent = 'Chưa cấu hình Google OAuth Client';
      authDesc.textContent = 'Vui lòng bấm nút "Cấu hình API" ở góc trên để nhập Client ID & Secret từ Google Cloud.';
      btnConnectGoogle.style.display = 'none';
      btnLogoutGoogle.style.display = 'none';
      isAuthenticated = false;
      return;
    }

    if (data.authenticated) {
      isAuthenticated = true;
      authStatusBox.className = 'status-box connected';
      const email = data.user?.emailAddress || 'Đã kết nối';
      const quota = data.storageQuota ? ` (Đã dùng ${formatBytes(parseInt(data.storageQuota.usage, 10))})` : '';
      authTitle.textContent = `Tài khoản: ${email}`;
      authDesc.textContent = `Đã cấp quyền truy cập Google Drive${quota}. Sẵn sàng sao chép.`;
      btnConnectGoogle.style.display = 'none';
      btnLogoutGoogle.style.display = 'inline-flex';
    } else {
      isAuthenticated = false;
      authStatusBox.className = 'status-box not-connected';
      authTitle.textContent = 'Chưa đăng nhập Google Drive';
      const redirectUri = `${window.location.origin}/api/auth/google/callback`;
      authDesc.innerHTML = `Nhấn "Đăng nhập Google". Lưu ý thêm Redirect URI này vào Google Cloud:<br><code style="color:#38bdf8;user-select:all;">${redirectUri}</code>`;
      btnConnectGoogle.style.display = 'inline-flex';
      btnLogoutGoogle.style.display = 'none';
    }
  } catch (err) {
    console.error('Lỗi kiểm tra auth:', err);
  }
}

// Lưu cấu hình OAuth
btnSaveConfig.addEventListener('click', async () => {
  const clientId = cfgClientId.value.trim();
  const clientSecret = cfgClientSecret.value.trim();
  const redirectUri = `${window.location.origin}/api/auth/google/callback`;

  if (!clientId || !clientSecret) {
    alert('Vui lòng điền đầy đủ Client ID và Client Secret!');
    return;
  }

  try {
    localStorage.setItem('dc_clientId', clientId);
    localStorage.setItem('dc_clientSecret', clientSecret);
  } catch (e) {}

  try {
    const res = await fetch('/api/auth/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, redirectUri })
    });
    const result = await res.json();
    if (result.success) {
      alert('Đã lưu cấu hình thành công! Bây giờ bạn có thể đăng nhập Google.');
      modalSettings.classList.remove('active');
      checkAuthStatus();
    } else {
      alert('Lỗi: ' + result.error);
    }
  } catch (err) {
    alert('Lỗi gửi yêu cầu: ' + err.message);
  }
});

// Đăng xuất Google
btnLogoutGoogle.addEventListener('click', async () => {
  if (!confirm('Bạn có chắc muốn đăng xuất khỏi tài khoản Google hiện tại?')) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    checkAuthStatus();
  } catch (err) {
    console.error(err);
  }
});

// Bắt đầu tạo Job Copy
copyForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!isAuthenticated) {
    alert('Bạn cần đăng nhập Google trước khi bắt đầu sao chép!');
    return;
  }

  const sourceUrlOrId = sourceUrlInput.value.trim();
  const destFolderName = destFolderNameInput.value.trim();
  const destFolderId = destFolderIdInput.value.trim();

  btnStartCopy.disabled = true;
  btnStartCopy.textContent = '⏳ Đang khởi tạo...';

  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrlOrId, destFolderName, destFolderId })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Có lỗi xảy ra');
    }

    // Chuyển sang theo dõi job
    trackJob(data.job.id);
    loadJobsHistory();
  } catch (err) {
    alert('Lỗi khởi động sao chép: ' + err.message);
  } finally {
    btnStartCopy.disabled = false;
    btnStartCopy.textContent = '🚀 Bắt đầu Sao Chép Ngay';
  }
});

// Theo dõi một Job theo ID
function trackJob(jobId) {
  if (currentEventSource) {
    currentEventSource.close();
  }
  currentJobId = jobId;

  noJobPlaceholder.style.display = 'none';
  activeJobContainer.style.display = 'flex';
  activeJobContainer.style.flexDirection = 'column';
  activeJobContainer.style.gap = '16px';

  currentEventSource = new EventSource(`/api/jobs/${jobId}/events`);

  currentEventSource.onmessage = (event) => {
    try {
      const job = JSON.parse(event.data);
      renderJobState(job);
    } catch (e) {
      console.error('Lỗi parse SSE:', e);
    }
  };

  currentEventSource.onerror = (err) => {
    console.warn('SSE connection closed or error');
  };
}

// Cập nhật giao diện theo trạng thái Job
function renderJobState(job) {
  // Trạng thái badge
  jobBadgeStatus.className = `badge-status status-${job.status}`;
  const statusTexts = {
    pending: 'Đang xếp hàng',
    running: 'Đang sao chép',
    completed: 'Đã hoàn tất',
    failed: 'Thất bại',
    cancelled: 'Đã hủy'
  };
  jobBadgeStatus.textContent = statusTexts[job.status] || job.status;

  // Cập nhật metrics
  statFiles.textContent = job.stats.copiedFiles;
  statFolders.textContent = job.stats.totalFolders;
  statSize.textContent = formatBytes(job.stats.copiedBytes);
  statErrors.textContent = job.stats.failedFiles;

  // Nút Drive đích
  if (job.destFolderLink) {
    btnOpenTargetDrive.style.display = 'inline-flex';
    btnOpenTargetDrive.href = job.destFolderLink;
  } else {
    btnOpenTargetDrive.style.display = 'none';
  }

  // Nút hủy
  if (job.status === 'running' || job.status === 'pending') {
    btnCancelJob.style.display = 'inline-flex';
  } else {
    btnCancelJob.style.display = 'none';
  }

  // Render logs
  if (job.logs && job.logs.length > 0) {
    logContainer.innerHTML = job.logs.map(log => 
      `<div class="log-line log-${log.type}">[${log.time}] ${escapeHtml(log.message)}</div>`
    ).join('');
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // Cập nhật trực tiếp dòng tương ứng ở bảng Lịch sử bên dưới theo thời gian thực
  const rowStatus = document.getElementById(`job-status-${job.id}`);
  const rowResult = document.getElementById(`job-result-${job.id}`);
  const rowLink = document.getElementById(`job-link-${job.id}`);
  if (rowStatus) {
    rowStatus.innerHTML = `<span class="badge-status status-${job.status}">${job.status}</span>`;
  }
  if (rowResult) {
    rowResult.textContent = `${job.stats.copiedFiles} files (${formatBytes(job.stats.copiedBytes)})`;
  }
  if (rowLink && job.destFolderLink) {
    rowLink.innerHTML = `<a href="${job.destFolderLink}" target="_blank" class="btn-link">Mở thư mục ↗</a>`;
  }
}

// Hủy Job
btnCancelJob.addEventListener('click', async () => {
  if (!currentJobId) return;
  if (!confirm('Bạn có chắc chắn muốn hủy tiến trình sao chép này?')) return;

  try {
    const res = await fetch(`/api/jobs/${currentJobId}/cancel`, { method: 'POST' });
    const data = await res.json();
    alert(data.message);
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
});

// Xóa log view
btnClearLog.addEventListener('click', () => {
  logContainer.innerHTML = '<div class="log-line log-info">[Ghi chú] Đã xóa màn hình console.</div>';
});

// Lịch sử Jobs
async function loadJobsHistory() {
  try {
    const res = await fetch('/api/jobs');
    const jobsList = await res.json();

    if (!jobsList || jobsList.length === 0) {
      jobsTableBody.innerHTML = `<tr><td colspan="6" class="text-center">Chưa có lịch sử sao chép</td></tr>`;
      return;
    }

    jobsTableBody.innerHTML = jobsList.map(j => {
      const timeStr = new Date(j.createdAt).toLocaleString('vi-VN');
      const badge = `<span class="badge-status status-${j.status}">${j.status}</span>`;
      const resultText = `${j.stats.copiedFiles} files (${formatBytes(j.stats.copiedBytes)})`;
      const linkDrive = j.destFolderLink 
        ? `<a href="${j.destFolderLink}" target="_blank" class="btn-link">Mở thư mục ↗</a>` 
        : '-';
      const actionBtn = `<button class="btn btn-outline btn-sm" onclick="trackJob('${j.id}')">Xem</button>`;

      return `
        <tr id="job-row-${j.id}">
          <td>${timeStr}</td>
          <td><code>${escapeHtml(j.sourceFolderId)}</code></td>
          <td id="job-status-${j.id}">${badge}</td>
          <td id="job-result-${j.id}">${resultText}</td>
          <td id="job-link-${j.id}">${linkDrive}</td>
          <td>${actionBtn}</td>
        </tr>
      `;
    }).join('');

    // Tự động hiển thị tiến trình đang chạy hoặc tiến trình gần nhất khi mở lại trang
    if (!currentJobId) {
      const targetJob = jobsList.find(j => j.status === 'running' || j.status === 'pending') || jobsList[0];
      if (targetJob) {
        trackJob(targetJob.id);
        // Khôi phục thông tin form từ job nếu người dùng chưa lưu vào localStorage
        if (!localStorage.getItem('dc_sourceUrl') && targetJob.sourceUrlOrId) {
          sourceUrlInput.value = targetJob.sourceUrlOrId;
        }
        if (!localStorage.getItem('dc_destFolderName') && targetJob.destFolderName) {
          destFolderNameInput.value = targetJob.destFolderName;
        }
        if (!localStorage.getItem('dc_destFolderId') && targetJob.destFolderId) {
          destFolderIdInput.value = targetJob.destFolderId;
        }
      }
    }
  } catch (err) {
    console.error('Lỗi tải lịch sử:', err);
  }
}

btnRefreshJobs.addEventListener('click', loadJobsHistory);

// Modal settings handlers
btnOpenSettings.addEventListener('click', () => {
  currentRedirectUri.textContent = `${window.location.origin}/api/auth/google/callback`;
  modalSettings.classList.add('active');
});
btnCloseSettings.addEventListener('click', () => modalSettings.classList.remove('active'));

// Modal docs handlers
btnOpenDocs.addEventListener('click', () => modalDocs.classList.add('active'));
btnCloseDocs.addEventListener('click', () => modalDocs.classList.remove('active'));

// Helper HTML escape
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Khởi chạy
window.addEventListener('DOMContentLoaded', () => {
  restoreFormFromLocal();

  // Bắt query param ?auth=success
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('auth') === 'success') {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  checkAuthStatus();
  loadJobsHistory();
});
