// Offline entry point; the extension uses exactly the same organizer module.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const O = require('./edge-extension/organize.js');
async function main() {
  const [source,destination,profile='reading'] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node organize_capture.cjs INPUT_JSON NEW_OUTPUT_DIRECTORY [reading|all]');
  const raw=fs.readFileSync(source);
  const prepared=await O.prepare(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,'')),{profile});
  const folder=path.resolve(destination);
  if(fs.existsSync(folder))throw new Error('Output directory already exists; existing exports are never overwritten');
  fs.mkdirSync(folder,{recursive:true});
  const txt=O.toText(prepared);
  fs.writeFileSync(path.join(folder,'整理原文.txt'),txt,{encoding:'utf8',flag:'wx'});
  fs.writeFileSync(path.join(folder,'整理记录.json'),JSON.stringify(prepared,null,2),{encoding:'utf8',flag:'wx'});
  const report={source:path.resolve(source),source_sha256:createHash('sha256').update(raw).digest('hex'),
    statistics:prepared.statistics,checks:prepared.checks,warnings:prepared.warnings,
    output_text_sha256:createHash('sha256').update(txt).digest('hex')};
  fs.writeFileSync(path.join(folder,'整理核对.json'),JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({output:folder,statistics:prepared.statistics,checks:prepared.checks}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
