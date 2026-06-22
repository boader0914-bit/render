const fs = require("fs");

const path = "web/data/location_dictionary.json";
const data = JSON.parse(fs.readFileSync(path, "utf8"));

const indexSet = (family, young, dayUse, industry, tourism, operation, competition, expansionRisk) => ({
  family: { label: "가족생활권지수", shortLabel: "가족", value: family },
  young: { label: "청년근교수요지수", shortLabel: "청년", value: young },
  dayUse: { label: "데이유즈가능지수", shortLabel: "데이유즈", value: dayUse },
  industry: { label: "산업평일수요지수", shortLabel: "산업", value: industry },
  tourism: { label: "관광목적성지수", shortLabel: "관광", value: tourism },
  operation: { label: "운영유지관리지수", shortLabel: "운영", value: operation },
  competition: { label: "경쟁혼잡지수", shortLabel: "경쟁혼잡", value: competition },
  expansionRisk: { label: "확장주의지수", shortLabel: "확장주의", value: expansionRisk }
});

const groups = [
  {
    groupKey: "kr_area_gyeonggi",
    searchKeyword: "경기도 글램핑",
    sido: "경기",
    aliases: ["경기 글램핑", "경기글램핑", "경기도글램핑", "수도권 글램핑"],
    marketSignal: 90,
    interpretation: "서울·수도권 생활권 수요와 근교 자연 관광이 동시에 작동하는 최대 경쟁 권역",
    role: "광역 검색으로 서울근교·수도권 수요의 크기와 광고 강도를 먼저 확인합니다.",
    strategy: "근교 수요 + 경쟁차별",
    salesFocus: "가평·양평은 경쟁 차별, 포천·안성은 운영 상품과 채널 공백을 우선 봅니다.",
    children: ["kr_gyeonggi_gapyeong", "kr_gyeonggi_yangpyeong", "kr_gyeonggi_pocheon", "kr_gyeonggi_anseong"],
    plannedKeywords: ["이천글램핑", "여주글램핑", "파주글램핑", "연천글램핑", "화성글램핑"]
  },
  {
    groupKey: "kr_area_gangwon",
    searchKeyword: "강원도 글램핑",
    sido: "강원",
    aliases: ["강원 글램핑", "강원글램핑", "강원도글램핑"],
    marketSignal: 86,
    interpretation: "산·호수·바다 관광 목적성이 강하고 계절성 관리가 중요한 숙박형 권역",
    role: "관광 앵커가 강한 지역과 수도권 당일·1박권 지역을 분리합니다.",
    strategy: "관광목적 + 계절가격",
    salesFocus: "홍천·춘천은 수도권 흡수, 평창·강릉·양양은 관광 목적형으로 별도 확장합니다.",
    children: ["kr_gangwon_hongcheon", "kr_gangwon_chuncheon"],
    plannedKeywords: ["평창글램핑", "강릉글램핑", "양양글램핑", "원주글램핑", "횡성글램핑"]
  },
  {
    groupKey: "kr_area_chungbuk",
    searchKeyword: "충북 글램핑",
    sido: "충북",
    aliases: ["충청북도 글램핑", "충청북도글램핑", "충북글램핑"],
    marketSignal: 68,
    interpretation: "내륙 자연 관광과 생활권 수요가 섞이지만 지역별 앵커 편차가 큰 권역",
    role: "권역 검색으로 후보를 넓게 보고, 단양·제천·충주처럼 목적성이 있는 지역을 분리합니다.",
    strategy: "자연관광 + 보수확장",
    salesFocus: "검색 노출은 있으나 상품 구성과 채널이 약한 업체를 우선 봅니다.",
    children: ["kr_chungbuk_danyang"],
    plannedKeywords: ["제천글램핑", "충주글램핑", "괴산글램핑", "보은글램핑", "옥천글램핑"]
  },
  {
    groupKey: "kr_area_chungnam",
    searchKeyword: "충남 글램핑",
    sido: "충남",
    aliases: ["충청남도 글램핑", "충청남도글램핑", "충남글램핑"],
    marketSignal: 72,
    interpretation: "서해안 관광과 대전·세종 생활권 흡수 지역이 나뉘는 복합 권역",
    role: "바다 관광형과 내륙 생활권 흡수형을 분리해 봅니다.",
    strategy: "바다관광 + 대전권 흡수",
    salesFocus: "태안·보령은 관광형, 공주·금산은 대전권 당일상품 가능성을 봅니다.",
    children: ["kr_chungnam_taean", "kr_chungnam_gongju"],
    plannedKeywords: ["보령글램핑", "금산글램핑", "서산글램핑", "당진글램핑", "아산글램핑"]
  },
  {
    groupKey: "kr_area_jeonbuk",
    searchKeyword: "전북 글램핑",
    sido: "전북",
    aliases: ["전라북도 글램핑", "전라북도글램핑", "전북글램핑"],
    marketSignal: 65,
    interpretation: "전주 생활권 흡수와 무주·남원 관광목적형이 분리되는 권역",
    role: "생활권 가까운 상품과 목적형 숙박 상품을 따로 판단합니다.",
    strategy: "생활권 + 관광목적",
    salesFocus: "완주는 전주권 캠프닉, 무주는 목적형 숙박과 계절 가격을 우선 봅니다.",
    children: ["kr_jeonbuk_muju", "kr_jeonbuk_wanju"],
    plannedKeywords: ["남원글램핑", "부안글램핑", "고창글램핑", "임실글램핑", "순창글램핑"]
  },
  {
    groupKey: "kr_area_jeonnam",
    searchKeyword: "전남 글램핑",
    sido: "전남",
    aliases: ["전라남도 글램핑", "전라남도글램핑", "전남글램핑"],
    marketSignal: 75,
    interpretation: "남해안 관광 앵커와 광주권 근교 흡수 지역이 함께 존재하는 권역",
    role: "여수·순천 같은 목적형과 담양·장성 같은 광주권 흡수형을 나눕니다.",
    strategy: "해양관광 + 광주권 흡수",
    salesFocus: "여수는 경쟁차별, 담양은 당일·가족상품 구성을 우선 봅니다.",
    children: ["kr_jeonnam_yeosu", "kr_jeonnam_damyang"],
    plannedKeywords: ["순천글램핑", "구례글램핑", "곡성글램핑", "장성글램핑", "화순글램핑"]
  },
  {
    groupKey: "kr_area_gyeongbuk",
    searchKeyword: "경북 글램핑",
    sido: "경북",
    aliases: ["경상북도 글램핑", "경상북도글램핑", "경북글램핑"],
    marketSignal: 74,
    interpretation: "경주 관광목적성과 대구권 근교 자연 수요가 함께 작동하는 권역",
    role: "관광 목적형과 대도시 인접 흡수형을 구분합니다.",
    strategy: "관광목적 + 대구권 흡수",
    salesFocus: "경주는 경쟁차별, 청도는 대구권 데이유즈와 캠프닉 구성을 봅니다.",
    children: ["kr_gyeongbuk_gyeongju", "kr_gyeongbuk_cheongdo"],
    plannedKeywords: ["포항글램핑", "문경글램핑", "안동글램핑", "영덕글램핑", "울진글램핑"]
  },
  {
    groupKey: "kr_area_gyeongnam",
    searchKeyword: "경남 글램핑",
    sido: "경남",
    aliases: ["경상남도 글램핑", "경상남도글램핑", "경남글램핑"],
    marketSignal: 76,
    interpretation: "부산·창원·진주 생활권 흡수와 남해안·지리산 관광목적형이 겹치는 권역",
    role: "부산 유입을 실제 관광수요와 업무·생활권 이동으로 나누어 해석합니다.",
    strategy: "인접흡수 + 자연관광",
    salesFocus: "밀양은 부산·대구권 흡수, 남해·산청은 목적형 숙박 완성도를 우선 봅니다.",
    children: ["kr_gyeongnam_miryang", "kr_gyeongnam_namhae", "kr_gyeongnam_sancheong", "kr_gyeongnam_sacheon"],
    plannedKeywords: ["하동글램핑", "거제글램핑", "함양글램핑", "합천글램핑", "통영글램핑"]
  },
  {
    groupKey: "kr_area_jeju",
    searchKeyword: "제주 글램핑",
    sido: "제주",
    aliases: ["제주도 글램핑", "제주도글램핑", "제주글램핑"],
    marketSignal: 80,
    interpretation: "항공 이동 기반 관광목적형 권역으로 숙박 품질과 지역 동선 설계가 핵심입니다.",
    role: "광역 수요는 강하지만 지역별 카드가 필요합니다.",
    strategy: "관광목적 + 체류동선",
    salesFocus: "애월·서귀포·동부권을 분리해 가격과 채널을 판단해야 합니다.",
    children: [],
    plannedKeywords: ["애월글램핑", "서귀포글램핑", "성산글램핑", "제주시글램핑"]
  }
];

const cardData = [
  ["kr_gyeonggi_gapyeong", "가평 글램핑", "수도권 주말 수요와 북한강·계곡 관광이 겹치는 대표 근교 경쟁 입지", "C_YOUNG_NEAR + C_COMPETITION_HIGH", indexSet(78, 76, 82, 32, 83, 70, 86, 48), "커플·친구 감성 숙박, 가족 물놀이, 데이유즈 BBQ, 서울근교 키워드", "경쟁이 매우 강해 대표 사진·후기·포함가 차별화가 필요"],
  ["kr_gyeonggi_yangpyeong", "양평 글램핑", "서울 동부·경기 남부 가족 수요와 자연 체류가 강한 근교 가족형 입지", "C_FAM_NEAR + C_COMPETITION_HIGH", indexSet(80, 68, 85, 42, 69, 75, 78, 40), "가족형 캠프닉, 당일 BBQ, 키즈·반려견 상품, 평일 진입가", "근교 대체지가 많아 가족 편의와 가격 포함범위를 명확히 해야 함"],
  ["kr_gangwon_hongcheon", "홍천 글램핑", "수도권 1박 자연관광과 계곡·숲 체류가 강한 숙박형 입지", "C_TOUR_DEST + C_BALANCED_EXPAND", indexSet(65, 58, 62, 38, 78, 58, 63, 48), "숲·계곡 숙박, 가족 주말 패키지, 장보기/식음 표준화", "운영 동선과 비수기 공실 관리가 중요"],
  ["kr_gangwon_chuncheon", "춘천 글램핑", "수도권 접근성과 호수·관광 앵커가 같이 작동하는 인접 관광 흡수형 입지", "C_YOUNG_NEAR + C_BALANCED_EXPAND", indexSet(74, 72, 78, 50, 75, 74, 68, 35), "커플·친구 데이유즈, 호수·레저 연계, 주말 숙박 패키지", "춘천 자체 관광 동선과 숙소 체류 이유를 함께 제시해야 함"],
  ["kr_chungbuk_danyang", "단양 글램핑", "도담삼봉·패러글라이딩 등 목적형 관광 앵커가 강한 내륙 관광 입지", "C_TOUR_DEST", indexSet(48, 52, 45, 30, 88, 55, 52, 50), "관광 후 숙박, 풍경형 객실, 조식·석식 패키지, 액티비티 연계", "당일권보다 목적형 숙박 완성도와 계절성 대응이 중요"],
  ["kr_chungnam_taean", "태안 글램핑", "서해안 바다 관광과 가족·커플 숙박 수요가 강한 해양 관광 입지", "C_TOUR_DEST + C_COMPETITION_HIGH", indexSet(60, 62, 52, 28, 86, 56, 72, 45), "바다뷰·노을·갯벌 콘텐츠, 가족 숙박, 성수기 가격 세분화", "바다권 경쟁이 있어 사진·위치·포함가 동기화가 필요"],
  ["kr_chungnam_gongju", "공주 글램핑", "대전·세종 생활권 흡수와 백제문화 관광이 결합되는 복합 입지", "C_FAM_NEAR + C_TOUR_DEST", indexSet(68, 60, 74, 48, 70, 68, 55, 35), "대전권 당일 BBQ, 가족 주말 숙박, 역사관광 연계 상품", "관광형 메시지와 근교형 메시지를 채널별로 분리해야 함"],
  ["kr_jeonbuk_muju", "무주 글램핑", "무주리조트·덕유산 목적 관광과 계절성이 큰 산악 관광 입지", "C_TOUR_DEST + C_MAINT_RISK", indexSet(50, 48, 42, 25, 84, 50, 48, 55), "스키·덕유산·계곡 연계 숙박, 석식 패키지, 성수기 프리미엄", "계절성 공실과 운영 인력 확보를 보수적으로 봐야 함"],
  ["kr_jeonbuk_wanju", "완주 글램핑", "전주 생활권 당일 수요와 자연 체류가 만나는 근교 복합 입지", "C_FAM_NEAR + C_BALANCED_EXPAND", indexSet(70, 58, 78, 62, 61, 70, 45, 34), "전주권 캠프닉, 가족 BBQ, 평일 모임, 주말 숙박 혼합", "전주권 데이유즈와 숙박 상품을 분리 구성하는 것이 유리"],
  ["kr_jeonnam_yeosu", "여수 글램핑", "남해안 대표 관광도시의 숙박 목적성과 경쟁 강도가 모두 높은 입지", "C_TOUR_DEST + C_COMPETITION_HIGH", indexSet(56, 66, 46, 45, 90, 68, 76, 42), "야경·바다·여행코스 연계 숙박, 커플 패키지, 성수기 가격 관리", "관광객은 많지만 숙박 선택지가 많아 차별화 문장이 중요"],
  ["kr_jeonnam_damyang", "담양 글램핑", "광주권 당일·주말 수요와 죽녹원·메타세쿼이아 관광이 결합되는 입지", "C_FAM_NEAR + C_TOUR_DEST", indexSet(72, 64, 82, 38, 76, 70, 62, 35), "광주권 캠프닉, 가족 숙박, 대나무숲 관광 연계, 당일 BBQ", "주말 집중 수요에 맞춰 당일상품과 숙박을 분리해야 함"],
  ["kr_gyeongbuk_gyeongju", "경주 글램핑", "국내 대표 역사관광 목적지로 숙박 목적성과 경쟁이 모두 강한 입지", "C_TOUR_DEST + C_COMPETITION_HIGH", indexSet(62, 65, 50, 38, 92, 72, 78, 40), "경주 여행코스 연계, 가족·커플 숙박, 조식·석식 포함 패키지", "관광지 선택지는 많아 리뷰·사진·위치 설명이 핵심"],
  ["kr_gyeongbuk_cheongdo", "청도 글램핑", "대구권 근교 수요와 자연·카페·와인터널 관광이 결합되는 입지", "C_YOUNG_NEAR + C_BALANCED_EXPAND", indexSet(68, 63, 76, 42, 72, 64, 58, 36), "대구권 데이유즈, 커플·친구 감성, 가족 주말 숙박, 카페 연계", "대구권 당일 수요와 숙박 수요를 가격표에서 분리해야 함"],
  ["kr_gyeongnam_miryang", "밀양 글램핑", "부산·대구 접근성과 계곡·자연 관광이 겹치는 인접 흡수형 입지", "C_FAM_NEAR + C_BALANCED_EXPAND", indexSet(66, 60, 74, 47, 70, 62, 52, 40), "부산·대구권 캠프닉, 가족 물놀이, 평일 소규모 모임, 주말 숙박", "부산 유입을 관광·생활권·업무 이동으로 나누어 검증해야 함"],
  ["kr_gyeongnam_namhae", "남해 글램핑", "남해안 풍경과 목적형 숙박 수요가 강하지만 운영 난도가 있는 관광 입지", "C_TOUR_DEST + C_MAINT_RISK", indexSet(52, 58, 38, 25, 88, 52, 55, 58), "바다뷰 숙박, 조용한 체류, 커플·가족 여행 패키지, 지역 관광 연계", "인력·세탁·수리 접근성과 비수기 공실을 보수적으로 봐야 함"]
];

const aliasMeta = {
  kr_gyeonggi_gapyeong: ["경기", "가평군", ["가평글램핑", "가평카라반", "서울근교글램핑"], 50, 80, "청평·남양주·서울 동북부 생활권 확인"],
  kr_gyeonggi_yangpyeong: ["경기", "양평군", ["양평글램핑", "양평카라반", "서울동부글램핑"], 50, 80, "하남·남양주·서울 동부 생활권 확인"],
  kr_gangwon_hongcheon: ["강원", "홍천군", ["홍천글램핑", "홍천카라반", "강원근교글램핑"], 70, 110, "수도권 1박권과 계곡 관광 확인"],
  kr_gangwon_chuncheon: ["강원", "춘천시", ["춘천글램핑", "춘천카라반", "남이섬근교"], 70, 100, "서울·가평·춘천 관광 동선 확인"],
  kr_chungbuk_danyang: ["충북", "단양군", ["단양글램핑", "단양카라반", "패러글라이딩글램핑"], 70, 110, "제천·영주·충주 연계 관광 확인"],
  kr_chungnam_taean: ["충남", "태안군", ["태안글램핑", "태안카라반", "서해글램핑"], 80, 120, "서해안 성수기와 바다뷰 경쟁 확인"],
  kr_chungnam_gongju: ["충남", "공주시", ["공주글램핑", "공주카라반", "대전근교글램핑"], 50, 80, "대전·세종 생활권 확인"],
  kr_jeonbuk_muju: ["전북", "무주군", ["무주글램핑", "무주카라반", "덕유산글램핑"], 80, 120, "덕유산·스키 시즌성 확인"],
  kr_jeonbuk_wanju: ["전북", "완주군", ["완주글램핑", "완주카라반", "전주근교글램핑"], 50, 80, "전주 생활권과 데이유즈 확인"],
  kr_jeonnam_yeosu: ["전남", "여수시", ["여수글램핑", "여수카라반", "여수바다글램핑"], 70, 110, "여수 관광동선과 해양권 경쟁 확인"],
  kr_jeonnam_damyang: ["전남", "담양군", ["담양글램핑", "담양카라반", "광주근교글램핑"], 50, 80, "광주 생활권과 죽녹원 관광 확인"],
  kr_gyeongbuk_gyeongju: ["경북", "경주시", ["경주글램핑", "경주카라반", "보문글램핑"], 70, 110, "경주 관광권과 숙박 경쟁 확인"],
  kr_gyeongbuk_cheongdo: ["경북", "청도군", ["청도글램핑", "청도카라반", "대구근교글램핑"], 50, 80, "대구 생활권과 카페·와인터널 관광 확인"],
  kr_gyeongnam_miryang: ["경남", "밀양시", ["밀양글램핑", "밀양카라반", "부산근교글램핑"], 60, 90, "부산·대구 흡수권 확인"],
  kr_gyeongnam_namhae: ["경남", "남해군", ["남해글램핑", "남해카라반", "남해바다글램핑"], 80, 120, "남해안 목적형 숙박과 운영 접근성 확인"]
};

const cards = cardData.map(([regionKey, searchKeyword, interpretation, primaryCluster, indexes, recommendedProduct, caution]) => ({
  regionKey,
  searchKeyword,
  interpretation,
  primaryCluster,
  indexes,
  recommendedProduct,
  caution
}));

const aliases = cards.map((card) => {
  const [sido, sigungu, names, primaryRadiusKm, secondaryRadiusKm, fallbackAction] = aliasMeta[card.regionKey];
  return {
    searchKeyword: card.searchKeyword,
    regionKey: card.regionKey,
    sido,
    sigungu,
    businessType: "글램핑",
    aliases: names,
    primaryRadiusKm,
    secondaryRadiusKm,
    fallbackAction
  };
});

function upsertBy(array, items, key) {
  const map = new Map((array || []).map((item) => [item[key], item]));
  items.forEach((item) => map.set(item[key], item));
  return [...map.values()];
}

data.regionGroups = upsertBy(data.regionGroups || [], groups, "groupKey");
data.aliases = upsertBy(data.aliases || [], aliases, "regionKey");
data.cards = upsertBy(data.cards || [], cards, "regionKey");
data.generatedAt = new Date().toISOString();
data.version = "location-dictionary-v0.2";

fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");

console.log(`regionGroups=${data.regionGroups.length} aliases=${data.aliases.length} cards=${data.cards.length}`);
