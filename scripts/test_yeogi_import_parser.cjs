const assert = require("node:assert/strict");
const {
  looksLikeYeogiCsvHeader,
  looksLikeYeogiExtractScript,
  parseYeogiImport,
  yeogiLowestPrice,
  yeogiTextLines
} = require("./yeogi_import_parser.cjs");

function names(rows) {
  return rows.map((row) => row.name);
}

function pick(rows) {
  return rows.map((row) => ({
    name: row.name,
    location: row.location,
    price: row.price,
    reservationAvailable: row.reservationAvailable
  }));
}

const compactText = [
  "캠핑가평 슈가 풀빌라&스파글램핑가평군남이섬 차량 20분9.8506명 평가반짝특가99,000원쿠폰 적용시88,407원이 가격으로 남은 객실 1개",
  "카라반포천 해핑글램핑포천시산정호수 차량 10분4.732명 평가120,000원",
  "펜션안성 M글램핑카라반안성시고삼저수지 차량 8분4.913명 평가숙박150,000원",
  "캠핑산청 월명글램핑산청군경호강 인근4.8110명 평가다른 날짜 확인"
].join("\n");

const compactRows = parseYeogiImport(compactText);
assert.equal(compactRows.length, 4);
assert.deepEqual(pick(compactRows), [
  {
    name: "가평 슈가 풀빌라&스파글램핑",
    location: "가평군",
    price: "88,407원",
    reservationAvailable: "Y"
  },
  {
    name: "포천 해핑글램핑",
    location: "포천시",
    price: "120,000원",
    reservationAvailable: "Y"
  },
  {
    name: "안성 M글램핑카라반",
    location: "안성시",
    price: "150,000원",
    reservationAvailable: "Y"
  },
  {
    name: "산청 월명글램핑",
    location: "산청군",
    price: "",
    reservationAvailable: "N"
  }
]);

const singleLineText = "캠핑포천 해핑글램핑포천시4.732명 평가120,000원이 가격으로 남은 객실 1개카라반안성 M글램핑카라반안성시4.913명 평가150,000원";
assert.deepEqual(names(parseYeogiImport(singleLineText)), ["포천 해핑글램핑", "안성 M글램핑카라반"]);

const genericNameCsvText = [
  "rank,name,price,location,reservation_available,raw",
  '1,"글램핑","280,000원","","Y","generic category noise"',
  '2,"캠핑","50,000원","","Y","generic category noise"',
  '3,"산청 지리산리조트글램핑","180,000원","산청군","Y","valid place"'
].join("\n");
assert.deepEqual(names(parseYeogiImport(genericNameCsvText)), ["산청 지리산리조트글램핑"]);

const genericNameText = [
  "글램핑",
  "280,000원",
  "캠핑",
  "50,000원",
  "산청 지리산리조트글램핑",
  "180,000원"
].join("\n");
assert.deepEqual(names(parseYeogiImport(genericNameText)), ["산청 지리산리조트글램핑"]);

const csvText = [
  "rank,name,price,location,reservation_available,raw",
  '1,"포천 해핑글램핑","120,000원","포천시","Y","쿠폰, 객실 1개"',
  '2,"산청 월명글램핑","","산청군","N","다른 날짜 확인"'
].join("\n");
assert.equal(looksLikeYeogiCsvHeader("rank,name,price,location"), true);
assert.deepEqual(pick(parseYeogiImport(csvText)), [
  {
    name: "포천 해핑글램핑",
    location: "포천시",
    price: "120,000원",
    reservationAvailable: "Y"
  },
  {
    name: "산청 월명글램핑",
    location: "산청군",
    price: "",
    reservationAvailable: "N"
  }
]);

assert.equal(looksLikeYeogiCsvHeader("99,000원,쿠폰 적용시88,407원"), false);
assert.equal(yeogiLowestPrice("반짝특가99,000원쿠폰 적용시88,407원"), "88,407원");
assert.equal(yeogiTextLines(singleLineText).length, 2);

const pastedScript = "(() => { const priceRe = /원/; const headers = ['name']; console.log(csv); })();";
assert.equal(looksLikeYeogiExtractScript(pastedScript), true);
assert.deepEqual(parseYeogiImport(pastedScript), []);

console.log("Yeogi import parser tests passed");
