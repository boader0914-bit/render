export function liveExplorationPayload(pointCount = 30) {
  const points = Array.from({ length: pointCount }, (_unused, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    state: "ready",
    averagePrice: 150000 + index * 1200,
    totalStock: 10,
    availableStock: Math.max(0, 8 - (index % 7)),
    reservationRate: { state: "ready", value: Math.min(1, (2 + (index % 7)) / 10) },
    bookingPace: index === pointCount - 1
      ? { state: "ready", value: 2.4, requiredLeadDays: [14, 7, 1] }
      : { state: "not-exposed", value: null, requiredLeadDays: [14, 7, 1] },
    otaExposed: index % 3 !== 0
  }));
  return {
    ok: true,
    metadata: {
      stage: 230,
      source: "v2-live-fresh-collection",
      providerMode: "live",
      collection: { enabled: true, configured: true, mode: "live" }
    },
    exploration: {
      state: "ready",
      scope: "national",
      tenantId: "tenant_private_999",
      map: {
        state: "ready",
        markers: [
          { companyRef: "sel_owner_001", companyId: "cmp_owner_001", companyName: "해변 스테이", regionLabel: "경남 통영", latitude: 34.85, longitude: 128.43, coordinateConfidence: "high", freshness: "오늘" },
          { companyRef: "sel_peer_002", companyId: "cmp_peer_002", companyName: "숲속 스테이", regionLabel: "강원 홍천", latitude: 37.69, longitude: 127.88, coordinateConfidence: "estimated", freshness: "1일 전" },
          { companyRef: "sel_peer_003", companyId: "cmp_peer_003", companyName: "산들 스테이", regionLabel: "충북 제천", latitude: 37.13, longitude: 128.19, coordinateConfidence: "low", freshness: "2일 전" }
        ],
        bounds: { north: 38.1, south: 34.4, east: 129, west: 127.2 },
        sourceAsset: { label: "승인 행정경계", version: "2026-01", license: "공공누리", sourceUrl: "https://secret.example/source" },
        rawPath: "C:\\private\\map.geojson"
      },
      ranking: {
        state: "ready",
        condition: { label: "V2 네이버 노출 순위", targetDate: "2026-07-30", channel: "naver" },
        rows: [
          { companyRef: "sel_peer_002", position: 2, companyId: "cmp_peer_002", companyName: "숲속 스테이", regionLabel: "강원 홍천", observedRank: 4, targetDate: "2026-07-30", channel: "naver", freshness: "1일 전" },
          { companyRef: "sel_owner_001", position: 1, companyId: "cmp_owner_001", companyName: "해변 스테이", regionLabel: "경남 통영", observedRank: 7, targetDate: "2026-07-30", channel: "naver", freshness: "오늘" }
        ],
        platforms: [{
          channel: "naver",
          targetDate: "2026-07-30",
          rows: [
            { companyRef: "sel_owner_001", position: 1, companyName: "해변 스테이", regionLabel: "경남 통영", observedRank: 7, freshness: "오늘" },
            { companyRef: "sel_peer_002", position: 2, companyName: "숲속 스테이", regionLabel: "강원 홍천", observedRank: 4, freshness: "1일 전" }
          ]
        }]
      },
      timeline: {
        state: "ready",
        from: "2026-07-01",
        to: pointCount <= 30 ? `2026-07-${String(pointCount).padStart(2, "0")}` : "2026-08-01",
        axisEveryDays: 7,
        points
      }
    }
  };
}
