const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// Firebase 콘솔에서 함수 배포 시 이 시크릿 값을 별도로 등록합니다 (코드에 직접 넣지 않음).
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const EXTRACTION_PROMPT = `당신은 한국 영수증/세금계산서/현금영수증 이미지를 읽고 회계 기록에 필요한 정보를 추출하는 도우미입니다.
이미지를 보고 아래 JSON 형식으로만 답하세요. 다른 설명이나 텍스트는 절대 포함하지 마세요.
값을 확실히 읽을 수 없으면 null로 두세요. 숫자는 쉼표나 원화 기호 없이 순수 숫자만 넣으세요.

{
  "date": "YYYY-MM-DD 형식의 거래일자 또는 작성일자",
  "partner": "거래처명 또는 공급자 상호",
  "desc": "무엇을 구매/이용했는지 짧은 한글 설명 (10자 내외)",
  "proof_type": "세금계산서 | 계산서 | 카드매출전표 | 현금영수증(지출증빙용) | 기타 중 하나",
  "supply_amount": 공급가액 숫자 (세금계산서/계산서인 경우, 아니면 null),
  "vat_amount": 부가세 숫자 (세금계산서/계산서인 경우, 아니면 null),
  "total_amount": 최종 합계금액 숫자,
  "confidence": "high | medium | low 중 하나, 이미지 판독 확신도"
}`;

exports.extractReceiptData = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: "asia-northeast3" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }

    const { imageBase64, mimeType } = request.data || {};
    if (!imageBase64 || !mimeType) {
      throw new HttpsError("invalid-argument", "이미지 데이터가 없습니다.");
    }
    const allowedMime = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedMime.includes(mimeType)) {
      throw new HttpsError(
        "invalid-argument",
        "이미지 파일만 지원합니다 (PDF는 아직 지원하지 않습니다)."
      );
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType,
                    data: imageBase64,
                  },
                },
                { type: "text", text: EXTRACTION_PROMPT },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error("Anthropic API error", errText);
        throw new HttpsError("internal", "AI 인식 서버 호출에 실패했습니다.");
      }

      const data = await response.json();
      const rawText = data?.content?.[0]?.text || "";
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new HttpsError("internal", "AI 응답을 해석하지 못했습니다.");
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return { ok: true, result: parsed };
    } catch (err) {
      logger.error("extractReceiptData failed", err);
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "처리 중 오류가 발생했습니다.");
    }
  }
);
