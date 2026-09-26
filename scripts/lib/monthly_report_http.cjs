"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createMonthlyReportHttpHandler({ service, sources, renderPdf, dataDir, requireAdmin, parseJsonBody, send, rateLimit = () => {} }) {
  const pdfDir = path.join(dataDir, "pdf");
  const rendering = new Map();
  async function pdfFor(report) {
    if (report.status !== "published") throw Object.assign(new Error("검수 후 발행한 리포트만 PDF로 내려받을 수 있습니다."), { statusCode: 409 });
    if (!/^mr_[a-zA-Z0-9_-]+$/.test(report.id)) throw Object.assign(new Error("리포트 번호가 올바르지 않습니다."), { statusCode: 400 });
    const file = path.join(pdfDir, `${report.id}.pdf`);
    try { return await fs.readFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (rendering.has(report.id)) return rendering.get(report.id);
    const work = (async () => {
      const buffer = await renderPdf(report);
      if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("PDF 생성 결과를 확인하지 못했습니다.");
      await fs.mkdir(pdfDir, { recursive: true });
      // Publish an entire PDF atomically. Existing issued copies are never replaced.
      const temp = path.join(pdfDir, `.${report.id}.${randomUUID()}.tmp`);
      await fs.writeFile(temp, buffer, { flag: "wx" });
      try { await fs.link(temp, file); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      finally { await fs.unlink(temp).catch(() => {}); }
      return fs.readFile(file);
    })();
    rendering.set(report.id, work);
    try { return await work; } finally { rendering.delete(report.id); }
  }
  return async function handleMonthlyReport(req, res, url, session) {
    const base = "/api/monthly-reports";
    if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return false;
    if (!requireAdmin(session, req, res)) return true;
    if (url.searchParams.size) { send(res, 400, { error: "월간 리포트 조회에는 별도의 URL 입력값을 사용하지 않습니다." }); return true; }
    const tail = url.pathname.slice(base.length).split("/").filter(Boolean);
    let payload;
    if (["POST", "PATCH"].includes(req.method)) {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { send(res, 415, { error: "JSON 형식으로 입력해 주세요." }); return true; }
      if (req.headers.origin) {
        let host = "";
        try { host = new URL(req.headers.origin).host; } catch {}
        if (!host || host !== req.headers.host) { send(res, 403, { error: "현재 서비스 화면에서 다시 요청해 주세요." }); return true; }
      }
      payload = await parseJsonBody(req);
      if (!payload || Array.isArray(payload) || typeof payload !== "object") { send(res, 400, { error: "입력 내용을 확인해 주세요." }); return true; }
      rateLimit(req, session);
    }
    if (!tail.length && req.method === "GET") send(res, 200, { reports: await service.list() });
    else if (tail.length === 1 && tail[0] === "options" && req.method === "GET") send(res, 200, await sources.options());
    else if (tail.length === 1 && tail[0] === "preview" && req.method === "POST") send(res, 200, await service.preview(payload));
    else if (!tail.length && req.method === "POST") send(res, 201, await service.create(payload));
    else if (tail.length === 1 && req.method === "GET") send(res, 200, await service.get(tail[0]));
    else if (tail.length === 1 && req.method === "PATCH") send(res, 200, await service.update(tail[0], payload));
    else if (tail.length === 2 && tail[1] === "publish" && req.method === "POST") send(res, 200, await service.publish(tail[0], payload));
    else if (tail.length === 2 && tail[1] === "revise" && req.method === "POST") send(res, 201, await service.revise(tail[0], payload));
    else if (tail.length === 2 && tail[1] === "rebuild" && req.method === "POST") send(res, 200, await service.rebuild(tail[0], payload));
    else if (tail.length === 2 && tail[1] === "pdf" && req.method === "GET") {
      const report = await service.get(tail[0]);
      const buffer = await pdfFor(report);
      const filename = `monthly-report-${report.month}-v${report.version || 1}.pdf`;
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": buffer.length,
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(`${report.title}.pdf`)}`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(buffer);
    } else send(res, 405, { error: "지원하지 않는 월간 리포트 요청입니다." });
    return true;
  };
}

module.exports = { createMonthlyReportHttpHandler };
