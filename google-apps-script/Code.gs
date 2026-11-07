/**
 * Google Apps Script Web App - Sao chép thư mục Google Drive trực tiếp trên Cloud
 * Không cần cài đặt server, tắt máy vẫn chạy!
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Google Drive Cloud Copier')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Bắt đầu sao chép
function startCopyProcess(sourceUrlOrId, destFolderName) {
  try {
    var sourceId = extractFolderId(sourceUrlOrId);
    if (!sourceId) {
      return { success: false, error: 'Không nhận diện được ID hoặc link thư mục nguồn.' };
    }

    var sourceFolder = DriveApp.getFolderById(sourceId);
    var targetFolderName = destFolderName && destFolderName.trim() 
      ? destFolderName.trim() 
      : '[Bản sao] ' + sourceFolder.getName();

    // Tạo thư mục đích trên Drive của bạn
    var destFolder = DriveApp.createFolder(targetFolderName);

    // Bắt đầu đệ quy sao chép
    var stats = { copiedFiles: 0, totalFolders: 0, logs: [] };
    copyRecursive(sourceFolder, destFolder, stats);

    return {
      success: true,
      destFolderUrl: destFolder.getUrl(),
      copiedFiles: stats.copiedFiles,
      totalFolders: stats.totalFolders,
      logs: stats.logs
    };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function copyRecursive(srcFolder, dstFolder, stats) {
  // 1. Copy tất cả files trong thư mục hiện tại
  var files = srcFolder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    try {
      file.makeCopy(file.getName(), dstFolder);
      stats.copiedFiles++;
      stats.logs.push('✓ Đã copy file: ' + file.getName());
    } catch (e) {
      stats.logs.push('✗ Lỗi copy file ' + file.getName() + ': ' + e.message);
    }
  }

  // 2. Duyệt đệ quy tất cả thư mục con
  var subFolders = srcFolder.getFolders();
  while (subFolders.hasNext()) {
    var subFolder = subFolders.next();
    var newSubFolder = dstFolder.createFolder(subFolder.getName());
    stats.totalFolders++;
    stats.logs.push('[Thư mục] Tạo: ' + subFolder.getName());
    copyRecursive(subFolder, newSubFolder, stats);
  }
}

function extractFolderId(input) {
  if (!input) return null;
  input = input.trim();
  var match = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  var idMatch = input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  return null;
}
