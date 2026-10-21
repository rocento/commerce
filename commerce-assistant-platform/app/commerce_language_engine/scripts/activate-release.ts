import {runReleaseCommand} from './release.ts';
import {closeDb} from '../src/database.ts';
// Compatibility command name, with the same mandatory evidence as release:promote.
try{console.log(JSON.stringify(await runReleaseCommand(['promote',...process.argv.slice(2)]),null,2));}finally{await closeDb();}
