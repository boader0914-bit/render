const fs = require("node:fs/promises");
const path = require("node:path");

const BUSINESS_ID = process.argv[2] || "244049";
const CHECK_IN = process.env.CHECK_IN || "2026-06-14";
const CHECK_OUT = process.env.CHECK_OUT || "2026-06-15";
const ADULTS = Number(process.env.ADULTS || 2);
const OUTPUT_DIR = path.resolve("outputs", "reservation_rate_probe");
const GRAPHQL_URL = process.env.NAVER_BOOKING_GRAPHQL || "https://m.booking.naver.com/graphql";

const headers = {
  "user-agent":
    "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9",
  accept: "*/*",
  "content-type": "application/json",
  origin: "https://m.booking.naver.com",
  referer: `https://m.booking.naver.com/booking/3/bizes/${BUSINESS_ID}/search?startDate=${CHECK_IN}&endDate=${CHECK_OUT}&adult=${ADULTS}`,
};

const bizItemsQuery = `
  query bizItems(
    $input: BizItemsParams
    $withTypeValues: Boolean = false
    $withReviewStat: Boolean = false
    $withBookedCount: Boolean = false
    $withBizItemDetail: Boolean = false
  ) {
    bizItems(input: $input) {
      id
      businessId
      bizItemId
      bizItemType
      bizItemSubType
      name
      desc
      startDate
      endDate
      isPeriodFixed
      isClosedBooking
      isClosedBookingUser
      isImp
      price
      minBookingCount
      maxBookingCount
      minBookingTime
      maxBookingTime
      bookingTimeUnitCode
      bookableSettingJson
      bookingCountSettingJson
      orderSettingJson
      priceByDates
      minMaxPrice {
        minPrice
        maxPrice
        isSinglePrice
      }
      typeValues @include(if: $withTypeValues) {
        bizItemId
        code
        codeValue
      }
      additionalPropertyJson {
        accommodationAdditionalProperty
      }
      bizItemResources {
        resourceUrl
        bizItemResourceSeq
        bizItemId
        order
        resourceTypeCode
      }
    }
  }
`;

const searchBizItemQuery = `
  query searchBizItem($bizItemSearchParams: BizItemSearchParams) {
    searchBizItem(input: $bizItemSearchParams) {
      id
      bizItems {
        id
        businessId
        bizItemId
        bizItemType
        bizItemSubType
        name
        desc
        startDate
        endDate
        isPeriodFixed
        isClosedBooking
        isClosedBookingUser
        isImp
        price
        minBookingCount
        maxBookingCount
        minBookingTime
        maxBookingTime
        bookingTimeUnitCode
        bookableSettingJson
        bookingCountSettingJson
        orderSettingJson
        priceByDates
        minMaxPrice {
          minPrice
          maxPrice
          isSinglePrice
        }
        typeValues {
          bizItemId
          code
          codeValue
        }
        additionalPropertyJson {
          accommodationAdditionalProperty
        }
        bizItemResources {
          resourceUrl
          bizItemResourceSeq
          bizItemId
          order
          resourceTypeCode
        }
      }
    }
  }
`;

const hourlyScheduleQuery = `
  query hourlySchedule($scheduleParams: ScheduleParams) {
    schedule(input: $scheduleParams) {
      bizItemSchedule {
        hourly {
          id
          name
          slotId
          scheduleId
          detailScheduleId
          unitStartDateTime
          unitStartTime
          unitBookingCount
          unitStock
          bookingCount
          occupiedBookingCount
          stock
          isBusinessDay
          isSaleDay
          isUnitSaleDay
          isUnitBusinessDay
          isHoliday
          duration
          desc
          minBookingCount
          maxBookingCount
          saleStartDateTime
          saleEndDateTime
          seatGroups {
            color
            maxPrice
            name
            remainStock
          }
          prices {
            price
            normalPrice
            bookingCount
            isImp
            saleStartDateTime
            saleEndDateTime
          }
        }
      }
    }
  }
`;

const dailyScheduleQuery = `
  query dailySchedule($scheduleParams: ScheduleParams) {
    schedule(input: $scheduleParams) {
      bizItemSchedule {
        daily {
          date
        }
      }
    }
  }
`;

const dailyStockScheduleQuery = `
  query dailyStockSchedule($scheduleParams: ScheduleParams) {
    schedule(input: $scheduleParams) {
      bizItemSchedule {
        daily {
          date
          id
          name
          scheduleId
          detailScheduleId
          stock
          unitStock
          bookingCount
          occupiedBookingCount
          remainStock
          isBusinessDay
          isSaleDay
          isUnitSaleDay
          isUnitBusinessDay
          isHoliday
          minBookingCount
          maxBookingCount
          saleStartDateTime
          saleEndDateTime
          prices {
            price
            normalPrice
            bookingCount
            isImp
          }
        }
      }
    }
  }
`;

function compact(value) {
  return JSON.stringify(value, null, 2).slice(0, 1200);
}

async function postGraphql(operationName, query, variables) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ operationName, variables, query }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { parseError: true, text: text.slice(0, 2000) };
  }
  return { status: response.status, data, text: text.slice(0, 2000), variables };
}

function candidateInputs() {
  return [
    {
      label: "bizItems_basic",
      operationName: "bizItems",
      query: bizItemsQuery,
      variables: {
        input: {
          businessId: BUSINESS_ID,
        },
        withTypeValues: true,
        withReviewStat: false,
        withBookedCount: true,
        withBizItemDetail: true,
      },
    },
    {
      label: "bizItems_dates",
      operationName: "bizItems",
      query: bizItemsQuery,
      variables: {
        input: {
          businessId: BUSINESS_ID,
          startDate: CHECK_IN,
          endDate: CHECK_OUT,
          startDateTime: `${CHECK_IN}T00:00:00`,
          endDateTime: `${CHECK_OUT}T00:00:00`,
        },
        withTypeValues: true,
        withReviewStat: false,
        withBookedCount: true,
        withBizItemDetail: true,
      },
    },
    {
      label: "searchBizItem_basic",
      operationName: "searchBizItem",
      query: searchBizItemQuery,
      variables: {
        bizItemSearchParams: {
          businessId: BUSINESS_ID,
        },
      },
    },
    {
      label: "searchBizItem_dates",
      operationName: "searchBizItem",
      query: searchBizItemQuery,
      variables: {
        bizItemSearchParams: {
          businessId: BUSINESS_ID,
          startDate: CHECK_IN,
          endDate: CHECK_OUT,
          startDateTime: `${CHECK_IN}T00:00:00`,
          endDateTime: `${CHECK_OUT}T00:00:00`,
          count: ADULTS,
        },
      },
    },
  ];
}

function extractItems(result) {
  if (Array.isArray(result?.data?.bizItems)) return result.data.bizItems;
  if (Array.isArray(result?.data?.searchBizItem?.bizItems)) return result.data.searchBizItem.bizItems;
  return [];
}

function stockLike(value) {
  const text = JSON.stringify(value || {});
  return /stock|remain|count|bookable|available|예약|재고|잔여|수량|마감/i.test(text);
}

function summarizeItems(items) {
  return items.slice(0, 30).map((item) => ({
    id: item.id,
    bizItemId: item.bizItemId,
    name: item.name,
    bizItemSubType: item.bizItemSubType,
    isImp: item.isImp,
    isClosedBooking: item.isClosedBooking,
    isClosedBookingUser: item.isClosedBookingUser,
    price: item.price,
    minMaxPrice: item.minMaxPrice,
    minBookingCount: item.minBookingCount,
    maxBookingCount: item.maxBookingCount,
    bookingCountSettingJson: item.bookingCountSettingJson,
    bookableSettingJson: item.bookableSettingJson,
    priceByDates: item.priceByDates,
    typeValues: item.typeValues,
    stockLike: stockLike(item),
  }));
}

async function probeSchedules(items) {
  const probes = [];
  for (const item of items.slice(0, 5)) {
    const scheduleParams = {
      businessId: BUSINESS_ID,
      businessTypeId: 3,
      startDateTime: `${CHECK_IN}T00:00:00`,
      endDateTime: `${CHECK_IN}T00:00:00`,
      bizItemId: item.bizItemId,
    };
    const result = await postGraphql("hourlySchedule", hourlyScheduleQuery, { scheduleParams });
    const daily = await postGraphql("dailySchedule", dailyScheduleQuery, { scheduleParams });
    const dailyStock = await postGraphql("dailyStockSchedule", dailyStockScheduleQuery, { scheduleParams });
    probes.push({
      bizItemId: item.bizItemId,
      name: item.name,
      status: result.status,
      variables: scheduleParams,
      data: result.data,
      dailyStatus: daily.status,
      dailyData: daily.data,
      dailyStockStatus: dailyStock.status,
      dailyStockData: dailyStock.data,
    });
  }
  return probes;
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const attempts = [];
  let bestItems = [];
  for (const candidate of candidateInputs()) {
    const result = await postGraphql(candidate.operationName, candidate.query, candidate.variables);
    const items = extractItems(result.data);
    attempts.push({
      label: candidate.label,
      operationName: candidate.operationName,
      status: result.status,
      variables: result.variables,
      itemCount: items.length,
      errors: result.data?.errors || null,
      sample: items.length ? summarizeItems(items).slice(0, 8) : compact(result.data),
    });
    if (items.length > bestItems.length) bestItems = items;
  }
  const scheduleProbes = bestItems.length ? await probeSchedules(bestItems) : [];
  const output = {
    businessId: BUSINESS_ID,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    adults: ADULTS,
    graphQlUrl: GRAPHQL_URL,
    attempts,
    bestItemCount: bestItems.length,
    bestItems: summarizeItems(bestItems),
    scheduleProbes,
  };
  const filePath = path.join(OUTPUT_DIR, `naver_booking_api_${BUSINESS_ID}_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    filePath,
    graphQlUrl: GRAPHQL_URL,
    attempts: attempts.map((attempt) => ({
      label: attempt.label,
      status: attempt.status,
      itemCount: attempt.itemCount,
      errors: attempt.errors,
      sample: Array.isArray(attempt.sample) ? attempt.sample.slice(0, 3) : attempt.sample,
    })),
    scheduleSummary: scheduleProbes.map((probe) => ({
      bizItemId: probe.bizItemId,
      name: probe.name,
      status: probe.status,
      hourlyCount: probe.data?.data?.schedule?.bizItemSchedule?.hourly?.length ?? null,
      dailyCount: probe.dailyData?.data?.schedule?.bizItemSchedule?.daily?.length ?? null,
      dailyStockErrors: probe.dailyStockData?.errors || null,
      errors: probe.data?.errors || null,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
