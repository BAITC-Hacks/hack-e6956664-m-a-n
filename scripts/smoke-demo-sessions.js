const base=process.env.SMOKE_URL||'http://localhost:3000';
function createSession(){let cookie='';return{async call(path,options={}){const response=await fetch(base+path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(options.headers||{})}});const setCookie=response.headers.getSetCookie?.()[0];if(setCookie)cookie=setCookie.split(';')[0];let data={};try{data=await response.json();}catch{}return{response,data};},json(method,body){return{method,body:JSON.stringify(body)};}};}
async function login(session,username){const{response,data}=await session.call('/api/auth/login',session.json('POST',{username,password:process.env.DEMO_PASSWORD||'HackAlemDemo2026!'}));if(!response.ok)throw new Error(`Demo login failed for ${username}: ${data.message}`);return data.user;}
async function main(){
 const customer=createSession(),vendor=createSession(),outsider=createSession();
 await login(customer,'demo.customer');await login(vendor,'demo.vendor');await login(outsider,'demo.outsider');
 const [cp,vp,op]=await Promise.all([customer.call('/api/profiles/HK-44733'),vendor.call('/api/profiles/HK-44733'),outsider.call('/api/profiles/HK-44733')]);
 if(!cp.data.reviews.some((r)=>r.username==='demo.friend'&&r.isFriend))throw new Error('Friend review was not highlighted for the customer account');
 if(op.data.reviews.some((r)=>r.username==='demo.friend'&&r.isFriend))throw new Error('Friend highlight leaked to a non-friend');
 if(cp.data.rating===null||cp.data.reviewCount!==2||cp.data.completedCount!==2)throw new Error('Demo rating or completed count mismatch');
 const dialogs=await customer.call('/api/dialogs'),sharedId=dialogs.data.items[0]?.id;if(!sharedId)throw new Error('Expected a seeded demo dialogue');
 const vendorDialogs=await vendor.call('/api/dialogs');if(!vendorDialogs.data.items.some((d)=>d.id===sharedId))throw new Error('Vendor did not see the shared dialogue');
 const body={body:'Smoke-test message between the two demo sessions.',nonce:crypto.randomUUID()};
 const sent=await customer.call(`/api/dialogs/${sharedId}/messages`,customer.json('POST',body));if(!sent.response.ok)throw new Error(sent.data.message||'Could not send demo message');
 const received=await vendor.call(`/api/dialogs/${sharedId}/messages`);const delivered=received.data.items.find((m)=>m.body===body.body&&!m.isMine);if(!delivered)throw new Error('The other account did not receive the message');if(!delivered.isDemo)throw new Error('A message created from a demo account was not labelled demo');
 const denied=await outsider.call(`/api/dialogs/${sharedId}/messages`);if(denied.response.status!==404)throw new Error(`Non-participant dialog access expected 404, got ${denied.response.status}`);
 const favorite=await customer.call('/api/favorites');if(!favorite.data.items.some((p)=>p.id==='HK-44733'))throw new Error('Favorite did not persist for customer');
 console.log(JSON.stringify({status:'passed',accounts:['demo.customer','demo.vendor','demo.outsider'],profile:'HK-44733',rating:cp.data.rating,reviewCount:cp.data.reviewCount,completedCount:cp.data.completedCount,friendReviewPersonalized:true,sharedDialog:sharedId,crossAccountMessage:true,demoMessageMarked:true,outsiderDenied:true,favoritePersisted:true},null,2));
}
main().catch((e)=>{console.error(e.message);process.exitCode=1;});
