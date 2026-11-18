// Prints read-only SQL for exact comparison of all imported fields against this source.
import { seed } from './catalog-source.mjs';
const literal="'"+JSON.stringify(seed.products).replaceAll("'","''")+"'::jsonb";
const comparison=Object.keys(seed.products[0]).map(k=>`p.${k} is distinct from e.${k}`).join(' or ');
console.log(`with expected as (select * from jsonb_populate_recordset(null::public.products,${literal}))
select count(*) as expected_rows,count(p.id) as matched_skus,
count(*) filter(where p.id is null or ${comparison}) as mismatched_rows,
(select count(*) from public.products) as database_rows,
(select count(*) from public.inventory_movements) as ledger_rows
from expected e left join public.products p on p.sku=e.sku;`);
