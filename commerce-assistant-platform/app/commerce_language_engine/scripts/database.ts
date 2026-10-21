import {migrate,closeDb} from '../src/database.ts';
try{await migrate();console.log('Database migration complete; no release activated.');}finally{await closeDb();}
