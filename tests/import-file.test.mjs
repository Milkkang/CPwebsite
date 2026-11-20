import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {unzipWorkbook,productFileCsv} from '../dist/import-file.js';
test('compressed XLSX archive is bounded and reads worksheet bytes',async()=>{
 const bytes=await readFile(new URL('./fixtures/import-valid.xlsx',import.meta.url));
 const archive=await unzipWorkbook(bytes);
 assert.ok(archive.names.includes('xl/worksheets/sheet1.xml'));
 assert.match(await archive.read('xl/worksheets/sheet1.xml'),/QA-IMPORT/);
 const encrypted=Buffer.from(bytes);const entry=encrypted.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));encrypted.writeUInt16LE(1,entry+8);
 await assert.rejects(unzipWorkbook(encrypted));
 const oversized=Buffer.from(bytes);oversized.writeUInt32LE(20*1024*1024,entry+24);
 await assert.rejects(unzipWorkbook(oversized));
 await assert.rejects(unzipWorkbook(new Uint8Array(40)));
});
test('CSV supports Excel UTF-8 BOM without evaluating formulas or using a network',async()=>{
 const text='\ufeffsku,name\r\nQA-1,Product';
 assert.equal(await productFileCsv(new File([text],'products.csv')),text.replace(/^\uFEFF/,''));
 await assert.rejects(productFileCsv(new File(['bad'],'products.xls')));
});
