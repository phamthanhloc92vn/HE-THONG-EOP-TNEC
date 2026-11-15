/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  VĂN THƯ – Lodeza EOP – Google Apps Script Web App          ║
 * ║  doGet  → Trả dữ liệu JSON cho Dashboard                    ║
 * ║  Deploy: Deploy as Web App (Execute as Me, Anyone)           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * HƯỚNG DẪN SỬ DỤNG:
 * 1. Mở Google Sheet "VĂN THƯ-TRUNGNAM E&C"
 * 2. Extensions → Apps Script → dán toàn bộ code này vào
 * 3. Deploy → New Deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy URL và thêm vào file .env.local của dashboard:
 *    NEXT_PUBLIC_VAN_THU_SCRIPT_URL=<URL vừa copy>
 */

// ─── Tên các tab ────────────────────────────────────────────────────────────
var TAB_CONG_VAN_DEN   = "Công văn đến";
var TAB_CONG_VAN_DI_1  = "Công văn đi 1";
var TAB_CONG_VAN_DI_2  = "Công văn đi 2";
var TAB_CONG_VAN_HDQT  = "Công văn đi 1 - HĐQT";

// ══════════════════════════════════════════════════════════════════════════
// GET API
// URL params:
//   ?action=getData&sheet=Công văn đến   → trả dữ liệu tab
//   ?action=getStats                      → trả KPI tổng hợp
//   (không cần auth – sheet public)
// ══════════════════════════════════════════════════════════════════════════
function doGet(e) {
  var params = e ? e.parameter : {};
  var action = params.action || "health";
  var ss     = SpreadsheetApp.getActiveSpreadsheet();

  try {
    // ── Trả dữ liệu 1 tab ──────────────────────────────────────────────
    if (action === "getData") {
      var sheetName = params.sheet || TAB_CONG_VAN_DEN;
      var ws = _getSheet(ss, sheetName);
      if (!ws) return response({ success: false, error: "Sheet không tồn tại: " + sheetName });

      var rows    = ws.getDataRange().getValues();
      var headers = rows[0];
      var data    = [];

      for (var i = 1; i < rows.length; i++) {
        var obj = {};
        var hasData = false;
        for (var j = 0; j < headers.length; j++) {
          var val = rows[i][j];
          if (val instanceof Date) {
            val = Utilities.formatDate(val, Session.getScriptTimeZone(), "dd/MM/yyyy");
          }
          obj[headers[j]] = val;
          if (val !== "" && val !== null && val !== undefined) hasData = true;
        }
        // Bỏ qua dòng hoàn toàn trống
        if (hasData) data.push(obj);
      }
      return response({ success: true, sheet: ws.getName(), total: data.length, data: data });
    }

    // ── Thống kê KPI ───────────────────────────────────────────────────
    if (action === "getStats") {
      return response(_buildVanThuStats(ss));
    }

    return response({ status: "OK", message: "VanThu-Lodeza EOP API Ready" });

  } catch (err) {
    return response({ success: false, error: err.message });
  }
}


// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════
function _getSheet(ss, name) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === name.trim().toLowerCase()) {
      return sheets[i];
    }
  }
  return null;
}

function _countRows(ss, tabName) {
  var ws = _getSheet(ss, tabName);
  if (!ws || ws.getLastRow() <= 1) return 0;
  // Đếm dòng có dữ liệu thực (cột A không rỗng)
  var vals = ws.getRange(2, 1, ws.getLastRow() - 1, 1).getValues();
  var count = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] !== "" && vals[i][0] !== null) count++;
  }
  return count;
}

function _buildVanThuStats(ss) {
  var den   = _countRows(ss, TAB_CONG_VAN_DEN);
  var di1   = _countRows(ss, TAB_CONG_VAN_DI_1);
  var di2   = _countRows(ss, TAB_CONG_VAN_DI_2);
  var hdqt  = _countRows(ss, TAB_CONG_VAN_HDQT);
  return {
    success:          true,
    cong_van_den:     den,
    cong_van_di_1:    di1,
    cong_van_di_2:    di2,
    cong_van_hdqt:    hdqt,
    tong_cong_van:    den + di1 + di2 + hdqt
  };
}

function response(d) {
  return ContentService
    .createTextOutput(JSON.stringify(d))
    .setMimeType(ContentService.MimeType.JSON);
}
