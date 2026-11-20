// Server-only bridge: session credentials never enter client JavaScript.
export async function staffProxy(request:Request,path:string[]){
 const production=process.env.NODE_ENV==='production';
 const configured=process.env.STAFF_ORIGIN??(production?'':'http://127.0.0.1:3101');
 if(!configured)return Response.json({code:'AUTH_NOT_CONFIGURED'},{status:503});
 const origin=new URL(configured).origin;
 if(production&&new URL(origin).protocol!=='https:')return Response.json({code:'AUTH_NOT_CONFIGURED'},{status:503});
 const route=path.join('/'),method=request.method;
 const allowed=(method==='GET'&&(['me','dashboard','clients'].includes(route)||/^stores\/[a-f0-9-]{36}$/.test(route)))||(method==='POST'&&(['auth/login','auth/logout'].includes(route)||/^stores\/[a-f0-9-]{36}\/(control|hosting)$/.test(route)||/^payments\/[a-f0-9-]{36}\/confirm$/.test(route)));
 if(!allowed)return Response.json({code:'NOT_FOUND'},{status:404});
 if(method!=='GET'&&(request.headers.get('origin')!==origin||request.headers.get('x-rocento-request')!=='1'))return Response.json({code:'FORBIDDEN'},{status:403});
 const cookieName=production?'__Host-rocento_staff':'rocento_staff';
 const cookie=request.headers.get('cookie')?.split(';').map(c=>c.trim()).find(c=>c.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(cookie&&/^[a-f0-9]{64}$/.test(cookie))headers.Authorization='Bearer '+cookie;
 const api=process.env.CONTROL_API_URL??'http://127.0.0.1:4100';
 try{
  let body:string|undefined;if(method!=='GET'){if(!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({code:'INVALID_INPUT'},{status:415});body=await request.text();if(Buffer.byteLength(body)>16384)return Response.json({code:'BODY_TOO_LARGE'},{status:413});}
  const response=await fetch(`${api}/api/v1/staff/${route}${method==='GET'?new URL(request.url).search:''}`,{method,headers,body,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
  const data=await response.json();const outputHeaders:Record<string,string>={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  if(route==='auth/login'&&response.ok){if(!/^[a-f0-9]{64}$/.test(data.sessionToken))throw Error('Invalid session');outputHeaders['Set-Cookie']=`${cookieName}=${data.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=14400${production?'; Secure':''}`;delete data.sessionToken;}
  if(route==='auth/logout'&&response.ok)outputHeaders['Set-Cookie']=`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production?'; Secure':''}`;
  return Response.json(data,{status:response.status,headers:outputHeaders});
 }catch{return Response.json({code:'SERVICE_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
