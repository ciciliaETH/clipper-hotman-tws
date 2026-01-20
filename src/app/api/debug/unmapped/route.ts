import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function admin(){
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function GET(req: Request){
  try{
    const supa = admin();
    const url = new URL(req.url);
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0,10);

    // build employee handle sets
    const { data: emps } = await supa
      .from('users')
      .select('id, tiktok_username, instagram_username')
      .eq('role','karyawan');
    const empIds = (emps||[]).map((u:any)=> String(u.id));
    const ttSet = new Set<string>();
    const igSet = new Set<string>();
    for (const u of emps||[]){
      const tt = String((u as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (tt) ttSet.add(tt);
      const ig = String((u as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase(); if (ig) igSet.add(ig);
    }
    if (empIds.length){
      const { data: ttMap } = await supa.from('user_tiktok_usernames').select('tiktok_username, user_id').in('user_id', empIds);
      for (const r of ttMap||[]){ const h=String((r as any).tiktok_username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) ttSet.add(h); }
      const { data: igMap } = await supa.from('user_instagram_usernames').select('instagram_username, user_id').in('user_id', empIds);
      for (const r of igMap||[]){ const h=String((r as any).instagram_username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) igSet.add(h); }
    }

    // usernames present in posts tables on that date
    const { data: ttRows } = await supa
      .from('tiktok_posts_daily')
      .select('username, taken_at, post_date')
      .or(`and(taken_at.gte.${date}T00:00:00Z,taken_at.lte.${date}T23:59:59Z),and(taken_at.is.null,post_date.eq.${date})`);
    const { data: igTaken } = await supa
      .from('instagram_posts_daily')
      .select('username, taken_at, post_date')
      .gte('taken_at', `${date}T00:00:00Z`).lte('taken_at', `${date}T23:59:59Z`);
    const { data: igLegacy } = await supa
      .from('instagram_posts_daily')
      .select('username, taken_at, post_date')
      .is('taken_at', null).eq('post_date', date);

    const ttAll = new Set<string>();
    for (const r of ttRows||[]){ const h=String((r as any).username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) ttAll.add(h); }
    const igAll = new Set<string>();
    for (const r of ([] as any[]).concat(igTaken||[], igLegacy||[])){ const h=String((r as any).username||'').trim().replace(/^@+/, '').toLowerCase(); if (h) igAll.add(h); }

    const ttUnmapped = Array.from(ttAll).filter(h=> !ttSet.has(h));
    const igUnmapped = Array.from(igAll).filter(h=> !igSet.has(h));

    return NextResponse.json({ date, tiktok: { present: ttAll.size, unmapped: ttUnmapped.slice(0,50) }, instagram: { present: igAll.size, unmapped: igUnmapped.slice(0,50) } });
  }catch(e:any){
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
