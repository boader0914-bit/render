import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorOperations, connectorFeedbackTone } from "./ConnectorOperations";

describe("Stage 231 connector operations shell", () => {
  it("does not add a settings surface while the runtime flag is off", () => {
    expect(renderToStaticMarkup(createElement(ConnectorOperations, { enabled: false }))).toBe("");
  });

  it("renders a fail-closed loading state without provider or synthetic results", () => {
    const markup = renderToStaticMarkup(createElement(ConnectorOperations, { enabled: true }));
    expect(markup).toContain("Signal connector 운영");
    expect(markup).toContain("provider 상태와 quota를 불러오는 중입니다.");
    expect(markup).not.toContain("합성 결과");
    expect(markup).not.toContain("실행 가능 provider");
  });

  it("never infers success tone from Korean sentence fragments", () => {
    expect(connectorFeedbackTone(false)).toBe("warning");
    expect("요청을 처리하지 못했습니다.").toContain("했습니다");
    expect(connectorFeedbackTone(true)).toBe("success");
  });
});
