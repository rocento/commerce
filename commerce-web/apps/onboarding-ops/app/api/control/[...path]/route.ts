import { staffProxy } from "../../../../lib/staff-proxy";
export const dynamic = "force-dynamic";
async function handler(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return staffProxy(request, (await context.params).path);
}
export { handler as GET, handler as POST };
