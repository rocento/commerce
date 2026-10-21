import { controlProxy } from "../../../../lib/control-proxy";
export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{path:string[]}>}){return controlProxy(request,(await context.params).path);}
export {handle as GET,handle as POST,handle as PUT};
