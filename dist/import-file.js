// Read ordinary .xlsx data without dependencies, formulas, macros or external links.
// Compressed/uncompressed limits are enforced before parsing any worksheet.
const fail=()=>{throw Error('Use an unencrypted .xlsx workbook with one data sheet (up to 1,000 products), or export Excel as CSV. Formulas are not accepted.');};
export async function unzipWorkbook(buffer){
 const bytes=new Uint8Array(buffer),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(bytes.length<22||bytes.length>2*1024*1024)fail();
 let end=-1;
 for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65557);n--)if(view.getUint32(n,true)===0x06054b50){end=n;break;}
 if(end<0||view.getUint16(end+4,true)!==0||view.getUint16(end+6,true)!==0)fail();
 const count=view.getUint16(end+10,true);let cursor=view.getUint32(end+16,true),total=0;
 if(count>200||cursor>=end)fail();
 const entries=new Map(),decoder=new TextDecoder('utf-8',{fatal:true});
 for(let i=0;i<count;i++){
  if(cursor+46>end||view.getUint32(cursor,true)!==0x02014b50)fail();
  const flags=view.getUint16(cursor+8,true),method=view.getUint16(cursor+10,true),size=view.getUint32(cursor+20,true),expanded=view.getUint32(cursor+24,true),nameLength=view.getUint16(cursor+28,true),extra=view.getUint16(cursor+30,true),comment=view.getUint16(cursor+32,true),offset=view.getUint32(cursor+42,true);
  total+=expanded;
  if(flags&1||![0,8].includes(method)||total>16*1024*1024||cursor+46+nameLength+extra+comment>end||offset+30>bytes.length)fail();
  const name=decoder.decode(bytes.subarray(cursor+46,cursor+46+nameLength));
  if(name.includes('..')||entries.has(name)||view.getUint32(offset,true)!==0x04034b50)fail();
  const start=offset+30+view.getUint16(offset+26,true)+view.getUint16(offset+28,true);
  if(start+size>cursor)fail();
  entries.set(name,{method,size,expanded,start});cursor+=46+nameLength+extra+comment;
 }
 const read=async name=>{
  const entry=entries.get(name);if(!entry)return null;
  let data=bytes.slice(entry.start,entry.start+entry.size);
  if(entry.method===8){
   const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')),reader=stream.getReader();let length=0;const chunks=[];
   try{while(true){const result=await reader.read();if(result.done)break;length+=result.value.length;if(length>entry.expanded||length>16*1024*1024){await reader.cancel();fail();}chunks.push(result.value);}}finally{reader.releaseLock();}
   data=new Uint8Array(length);let index=0;for(const chunk of chunks){data.set(chunk,index);index+=chunk.length;}
  }
  if(data.length!==entry.expanded)fail();return decoder.decode(data);
 };
 return {read,names:[...entries.keys()]};
}
export async function productFileCsv(file){
 if(file.size>2*1024*1024)throw Error('Use a CSV or Excel file below 2 MB.');
 if(/\.csv$/i.test(file.name))return file.text();
 if(!/\.xlsx$/i.test(file.name))fail();
 const archive=await unzipWorkbook(await file.arrayBuffer());
 const parse=text=>{
  if(!text||/<!DOCTYPE|<!ENTITY/i.test(text))fail();
  const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))fail();return doc;
 };
 const workbook=parse(await archive.read('xl/workbook.xml'));
 const sheets=[...workbook.getElementsByTagName('sheet')];if(sheets.length!==1)fail();
 const relId=sheets[0].getAttribute('r:id');
 const relations=parse(await archive.read('xl/_rels/workbook.xml.rels'));
 const rel=[...relations.getElementsByTagName('Relationship')].find(row=>row.getAttribute('Id')===relId);
 if(!rel||rel.getAttribute('TargetMode')==='External')fail();
 const target=rel.getAttribute('Target')??'';
 const path=target.startsWith('/xl/')?target.slice(1):'xl/'+target;
 if(!/^xl\/worksheets\/[A-Za-z0-9_-]+\.xml$/.test(path))fail();
 const sharedXml=await archive.read('xl/sharedStrings.xml');
 const shared=sharedXml?[...parse(sharedXml).getElementsByTagName('si')].map(si=>[...si.getElementsByTagName('t')].map(t=>t.textContent).join('')):[];
 const sheet=parse(await archive.read(path));if(sheet.getElementsByTagName('f').length)fail();
 const rows=[...sheet.getElementsByTagName('row')];if(rows.length<2||rows.length>1001)fail();
 const values=rows.map(row=>{
  const cells=[];
  for(const cell of row.getElementsByTagName('c')){
   const ref=cell.getAttribute('r')??'',column=ref.match(/^([A-Z]{1,2})[1-9][0-9]*$/)?.[1];if(!column)fail();
   let index=0;for(const char of column)index=index*26+char.charCodeAt(0)-64;index--;if(index>30)fail();
   const type=cell.getAttribute('t'),raw=cell.getElementsByTagName('v')[0]?.textContent??'';
   if(type==='e')fail();
   let value=type==='s'?shared[Number(raw)]:type==='inlineStr'?[...cell.getElementsByTagName('t')].map(t=>t.textContent).join(''):type==='b'?(raw==='1'?'true':'false'):raw;
   if(value===undefined||value.length>10000)fail();cells[index]=value;
  }
  return cells;
 });
 const width=values[0].length;
 if(values.some(row=>row.length>width))fail();
 return values.map(row=>Array.from({length:width},(_,i)=>'"'+String(row[i]??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
}
