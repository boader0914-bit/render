'use strict';
const fs=require('node:fs'),path=require('node:path');
// Invented, local test evidence. This helper never calls a provider or a collector.
function writeInsightCollectionFixture(dataDir,{name='검수 예시 글램핑',placeId='0000000001',days=30}={}) {
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10),stamp=new Date().toISOString();
  const add=n=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const runId='insight_fixture_glamping_'+today.replaceAll('-','')+'_090000',runDir=path.join(dataDir,'outputs',runId);
  fs.mkdirSync(runDir,{recursive:true});
  const products=Array.from({length:days},(_,n)=>[
    {date:add(n),bizItemId:'fixture_a',name:'포레스트 A동',saleType:'숙박',stock:10,bookingCount:n%4,available:10-n%4,price:180000,open:true},
    {date:add(n),bizItemId:'fixture_b',name:'가든 B동',saleType:'숙박',stock:7,bookingCount:2,available:5,price:220000,open:n!==2},
  ]).flat();
  const fields={query:'검수 지역 글램핑',place_id:placeId,업체명:name,overall_rank:1,주소:'경남 산청군 검수로 1',카테고리:'글램핑',숙박유형클러스터:'글램핑',예약:'Y',url:'https://pcmap.place.naver.com/accommodation/'+placeId,네이버예약사업자ID:'0000000901',네이버예약재고수집상태:'수집 완료',숙박확인재고수:17,숙박예약가능수:15,숙박판매완료수:2,예약최저가:180000,예약리스트유형:'객실 종류별 리스트',주간재고수집일수:days,네이버요일별상품상세JSON:JSON.stringify(products)};
  const foreign={...fields,place_id:'0000009999',업체명:name,네이버예약사업자ID:'0000000999',네이버요일별상품상세JSON:JSON.stringify([{...products[0],name:'다른 업체 전용 객실'}])};
  const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  const file='fixture_glamping_crawl_test.csv';fs.writeFileSync(path.join(runDir,file),[Object.keys(fields),Object.values(fields),Object.values(foreign)].map(row=>row.map(cell).join(',')).join('\n'));
  fs.writeFileSync(path.join(runDir,'manifest.json'),JSON.stringify({schemaVersion:1,keyword:'검수 지역 글램핑',searchMode:'keyword',collectionMode:'precision',collectionPurpose:'revenue_detail',dayUseMode:'inspect',productMode:'all',checkIn:today,checkOut:add(1),adults:2,bookingRangeDays:days,collectedAt:stamp,counts:{platformRows:2},files:[file],fileRoles:{platform:file},collectionQuality:{status:'complete'}}));
  return {runId,today,stamp,products};
}
module.exports={writeInsightCollectionFixture};
