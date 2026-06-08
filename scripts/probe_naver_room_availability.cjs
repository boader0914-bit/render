const fs = require("node:fs/promises");
const path = require("node:path");

const PLACE_ID = process.argv[2] || "1188470596";
const CHECK_IN = process.env.CHECK_IN || "2026-06-14";
const CHECK_OUT = process.env.CHECK_OUT || "2026-06-15";
const GUEST = String(process.env.ADULTS || 2);
const OUTPUT_DIR = path.resolve("outputs", "reservation_rate_probe");

const query = `
  query bookingDetails(
    $id: String!
    $isNx: Boolean
    $checkin: String
    $checkout: String
    $entry: String
    $guest: String
    $roomIds: String
    $size: Int
    $page: Int = 0
  ) {
    business: placeDetail(input: { id: $id, isNx: $isNx, deviceType: "mobile" }) {
      base {
        id
        name
        category
      }
      naverBooking {
        bookingBusinessId
        naverBookingUrl
        naverBookingHubUrl
      }
      accommodationBookingDetails(checkin: $checkin, checkout: $checkout, entry: $entry, roomIds: $roomIds, guest: $guest, size: $size, page: $page) {
        ...AccommodationBookingDetails
      }
    }
  }

  fragment AccommodationBookingDetails on AccommodationBookingDetails {
    roomTotal
    siteDesc
    agencyName
    images
    businessTypeId
    rooms {
      reprUrl
      resrvUrl
      isBookable
      isMatching
      bookingType
      resocId
      resocName
      resocDesc
      cond2Val
      cond3Val
      subImage
      excptMsg
      minPrice
      maxPrice
      index
      todayDealRate
      discountText
      isNPayUsed
      nPayRegStatusCode
      bizItemSubType
      minBookingTime
      accommodationAdditionalProperty {
        checkInTime
        checkOutTime
        isFixedRoomComposition
        roomCompositions {
          name
          bedroomCompositions {
            name
            type
            bunkBed
            kingBed
            queenBed
            doubleBed
            singleBed
            beddingSet
            familyBed
            sofaBed
            isStudioRoom
          }
          bathroomCompositions {
            name
            isPrivate
          }
          campingSiteCompositions {
            name
            type
            width
            height
            floorType
            isCaravanAccessible
            isTrailerAccessible
            parkingPositionType
          }
        }
        roomType
      }
    }
  }
`;

function typeKey(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .replace(/\([^)]*랜덤[^)]*\)/g, "")
    .replace(/\d+호|\d+번|[A-Z]-?\d+/gi, "")
    .trim();
}

function classifyNaverRooms(rooms = [], roomTotal = 0) {
  const perRoomLike = roomTotal > 0 && rooms.length >= Math.min(roomTotal, 5) &&
    new Set(rooms.map((room) => typeKey(room.resocName))).size > 1;
  const typeMap = new Map();
  for (const room of rooms) {
    const key = typeKey(room.resocName) || room.resocName || String(room.resocId);
    if (!typeMap.has(key)) {
      typeMap.set(key, {
        typeName: key,
        listedCount: 0,
        availableCount: 0,
        sampleNames: [],
      });
    }
    const bucket = typeMap.get(key);
    bucket.listedCount += 1;
    if (room.isBookable !== false) bucket.availableCount += 1;
    if (bucket.sampleNames.length < 3) bucket.sampleNames.push(room.resocName);
  }
  return {
    listType: perRoomLike ? "객실별 예약리스트 추정" : "객실 종류별 리스트 추정",
    typeBuckets: Array.from(typeMap.values()),
  };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const endpoint = "https://pcmap-api.place.naver.com/graphql";
  const referer = `https://pcmap.place.naver.com/accommodation/${PLACE_ID}/room?checkin=${CHECK_IN}&checkout=${CHECK_OUT}&guest=${GUEST}`;
  const variables = {
    id: PLACE_ID,
    isNx: false,
    checkin: CHECK_IN,
    checkout: CHECK_OUT,
    entry: "plt",
    guest: GUEST,
    roomIds: null,
    size: 50,
    page: 0,
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      "accept-language": "ko-KR,ko;q=0.9",
      origin: "https://pcmap.place.naver.com",
      referer,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    },
    body: JSON.stringify({
      operationName: "bookingDetails",
      query,
      variables,
    }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { parseError: true, text: text.slice(0, 1000) };
  }

  const details = data?.data?.business?.accommodationBookingDetails || {};
  const rooms = details.rooms || [];
  const reservableCount = rooms.filter((room) => room.isBookable !== false).length;
  const classification = classifyNaverRooms(rooms, details.roomTotal || 0);
  const output = {
    placeId: PLACE_ID,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guest: GUEST,
    status: response.status,
    endpoint,
    roomTotal: details.roomTotal ?? null,
    listedRoomCount: rooms.length,
    reservableCount,
    reservationAvailabilityProxy: rooms.length ? Number((reservableCount / rooms.length).toFixed(3)) : null,
    ...classification,
    rooms: rooms.map((room) => ({
      resocId: room.resocId,
      resocName: room.resocName,
      isBookable: room.isBookable,
      minPrice: room.minPrice,
      maxPrice: room.maxPrice,
      cond2Val: room.cond2Val,
      cond3Val: room.cond3Val,
      resrvUrl: room.resrvUrl,
      excptMsg: room.excptMsg,
    })),
    rawError: data?.errors || data?.error || null,
    rawDataSample: rooms.length ? null : data,
  };

  const filePath = path.join(OUTPUT_DIR, `naver_room_availability_${PLACE_ID}_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    filePath,
    status: output.status,
    roomTotal: output.roomTotal,
    listedRoomCount: output.listedRoomCount,
    reservableCount: output.reservableCount,
    reservationAvailabilityProxy: output.reservationAvailabilityProxy,
    listType: output.listType,
    sampleRooms: output.rooms.slice(0, 5),
    rawError: output.rawError,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
