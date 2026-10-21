import {readFileSync, writeFileSync, renameSync} from 'node:fs';
import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';

// The encryption key is mounted separately from the persistent data directory.
// Only metadata leaves this module through list(); passwords are write-only in the API.
export function connectionVault(config) {
  if (!config.vaultFile) return null;
  const key=readFileSync(config.vaultKeyFile);
  if(key.length!==32)throw new Error('Connection encryption key must be 32 bytes.');
  let entries={};
  try {
    const bytes=readFileSync(config.vaultFile), decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(12,28));
    entries=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
  } catch(error) {if(error.code!=='ENOENT')throw new Error('Cannot open saved connections.');}
  const save=next=>{
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(next)),cipher.final()]);
    const tmp=config.vaultFile+'.tmp';
    writeFileSync(tmp,Buffer.concat([nonce,cipher.getAuthTag(),encrypted]),{mode:0o600});
    renameSync(tmp,config.vaultFile);entries=next;
  };
  return {
    get:name=>Object.hasOwn(entries,name)?entries[name]:null,
    names:()=>Object.keys(entries).filter(name=>Object.hasOwn(config.stores,name)),
    list:()=>Object.keys(config.stores).map(store=>({store,saved:!!entries[store],email:entries[store]?.email??'',updatedAt:entries[store]?.updatedAt??null})),
    set:(name,email,password)=>save({...entries,[name]:{email,password,updatedAt:new Date().toISOString()}}),
    remove:name=>{const next={...entries};delete next[name];save(next);},
  };
}
