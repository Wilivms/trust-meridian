import { read, sv } from './stellar.mjs';
const V = 'CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN';
for (const [id, m] of [[V, 'get_assets'], ['CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY', 'asset']]) {
  try { console.log(m, JSON.stringify(await read(id, m), (k, v) => typeof v === 'bigint' ? v.toString() : v)); } catch (e) { console.log(m, 'ERR', e.message.slice(0, 300)); }
}
