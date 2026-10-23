'use strict';
const {createHash}=require('node:crypto');
const publicTypes=new Set(['text/javascript','text/css','font/otf','image/svg+xml']);
const hash=data=>createHash('sha256').update(data).digest('hex');

async function replaceAsync(text,pattern,replace){
  const matches=[...text.matchAll(pattern)],values=await Promise.all(matches.map(replace));
  let result='',at=0;
  for(let index=0;index<matches.length;index++){const match=matches[index];result+=text.slice(at,match.index)+values[index];at=match.index+match[0].length;}
  return result+text.slice(at);
}

function createPublicAssetVersions({assets,readAsset}){
  if(!(assets instanceof Map)||typeof readAsset!=='function')throw Error('Public asset map and reader are required');
  const allowed=new Map([...assets].filter(([url,asset])=>typeof url==='string'&&/^\/(?!\/)[^?#]+$/.test(url)&&asset&&publicTypes.has(asset.type)).map(([url,asset])=>[url,{...asset}]));
  const cache=new Map(),pending=new Map();
  function reference(value){
    if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return null;
    let url;try{url=new URL(value,'https://public-asset.invalid');}catch{return null;}
    if(url.origin!=='https://public-asset.invalid'||!allowed.has(url.pathname)||[...url.searchParams.keys()].some(key=>key!=='v'))return null;
    return {path:url.pathname,fragment:url.hash};
  }
  async function get(url){
    const asset=allowed.get(url);if(!asset)return null;
    if(pending.has(url))return pending.get(url);
    const task=(async()=>{
      const raw=await readAsset(asset.file);if(!Buffer.isBuffer(raw?.data))throw Error('Public asset reader must return a Buffer');
      const previous=cache.get(url),sourceEtag=raw.etag||hash(raw.data);
      if(asset.type!=='text/css'&&previous?.sourceEtag===sourceEtag)return previous;
      let data=raw.data;
      if(asset.type==='text/css'){
        // Only font leaves are rewritten: font -> CSS -> HTML has no cycles.
        const text=await replaceAsync(data.toString('utf8'),/\burl\(\s*(?:(["'])(\/[^"']*)\1|(\/[^\s)]*))\s*\)/g,async match=>{
          const link=reference(match[2]||match[3]);if(!link||allowed.get(link.path)?.type!=='font/otf')return match[0];
          try{const font=await get(link.path);return `url('${link.path}?v=${font.version}${link.fragment}')`;}
          catch{return match[0];} // A missing font must not prevent CSS/HTML delivery.
        });
        data=Buffer.from(text);
      }
      const version=hash(data);
      if(previous?.version===version)return previous;
      const entry={data,version,sourceEtag,etag:'"'+createHash('sha256').update(data).digest('base64url')+'"'};
      cache.set(url,entry);return entry;
    })();
    pending.set(url,task);
    try{return await task;}finally{if(pending.get(url)===task)pending.delete(url);}
  }
  async function html(data){
    if(!Buffer.isBuffer(data))throw Error('Public HTML reader must return a Buffer');
    const rewritten=await replaceAsync(data.toString('utf8'),/\b(src|href)\s*=\s*(["'])(\/[^"']*)\2/g,async match=>{
      const link=reference(match[3]);if(!link)return match[0];
      try{const asset=await get(link.path);return `${match[1]}=${match[2]}${link.path}?v=${asset.version}${link.fragment}${match[2]}`;}
      catch{return match[0];} // Leave an unavailable resource's failure on its own GET.
    });
    return Buffer.from(rewritten);
  }
  function immutable(url,asset){
    return Boolean(asset&&url.searchParams.getAll('v').length===1&&url.searchParams.get('v')===asset.version&&[...url.searchParams.keys()].every(key=>key==='v'));
  }
  return {get,html,immutable};
}
module.exports={createPublicAssetVersions};
