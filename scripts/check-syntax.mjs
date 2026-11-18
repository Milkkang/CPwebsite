import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for(const folder of ['dist','src'])for(const file of readdirSync(folder).filter(f=>/\.(m?js)$/.test(f))){const r=spawnSync(process.execPath,['--check',folder+'/'+file],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(r.status??1);}}
console.log('PASS: all front-end and Worker modules parse');
