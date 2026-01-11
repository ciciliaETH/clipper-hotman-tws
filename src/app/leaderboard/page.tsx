'use client';

import { useEffect, useMemo, useState } from 'react';
import TopViralVideos from '@/components/TopViralVideos';

type Row = {
  username: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  total?: number;
};

export default function LeaderboardPage() {
  const [month, setMonth] = useState<string>(()=> new Date().toISOString().slice(0,7)); // YYYY-MM
  const [interval, setIntervalVal] = useState<'days7'|'days28'>('days7');
  const [period, setPeriod] = useState<{ start: string | null; end: string | null } | null>(null)
  const [prizes, setPrizes] = useState<{ first_prize: number; second_prize: number; third_prize: number } | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const [weeklyStart, setWeeklyStart] = useState<string>('')
  const [weeklyEnd, setWeeklyEnd] = useState<string>('')
  const [campaignId, setCampaignId] = useState<string>('')
  const [users, setUsers] = useState<any[]>([])
  const accrualCutoff = (process.env.NEXT_PUBLIC_ACCRUAL_CUTOFF_DATE as string) || '2026-01-02';
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [selectedAvatar, setSelectedAvatar] = useState<string | null>(null)
  const [selectedRow, setSelectedRow] = useState<Row | null>(null)
  const [selectedUser, setSelectedUser] = useState<any | null>(null)
  const [showAvatarCard, setShowAvatarCard] = useState<boolean>(false)
  const [employeeGroups, setEmployeeGroups] = useState<Record<string,string[]>>({})
  
  // Custom date states
  const [useCustomDates, setUseCustomDates] = useState(false);
  const [customStart, setCustomStart] = useState('2026-01-02');
  const [customEnd, setCustomEnd] = useState('2026-01-02');

  const loadEmployees = async (m: string, iv: 'days7'|'days28') => {
    setLoading(true); setError(null);
    try {
      const url = new URL('/api/leaderboard', window.location.origin);
      // Global leaderboard semua karyawan (bukan hanya 1 group)
      url.searchParams.set('mode','accrual');
      url.searchParams.set('scope','employees');
      
      if (useCustomDates) {
        const start = new Date(customStart);
        const end = new Date(customEnd);
        const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        url.searchParams.set('days', String(days));
        url.searchParams.set('cutoff', customStart);
        url.searchParams.set('custom', '1');
      } else {
        url.searchParams.set('days', iv==='days7' ? '7' : '28');
      }
      
      const res = await fetch(url.toString());
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to load leaderboard');
      setPrizes(json?.prizes || null);
      if ('start' in json || 'end' in json) setPeriod({ start: json.start ?? null, end: json.end ?? null });
      setRows(json?.data || []);
    } catch(e:any) {
      setError(e?.message || 'Unknown error');
    } finally { setLoading(false); }
  }

  useEffect(() => {
    loadEmployees(month, interval);
    const t = setInterval(()=> setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [month, interval, weeklyStart, weeklyEnd, useCustomDates, customStart, customEnd])

  useEffect(() => {
    // fetch users for avatar mapping
    const load = async () => {
      try { const r = await fetch('/api/get-users'); const j = await r.json(); if (r.ok) setUsers(j||[]); } catch {}
    };
    load();
  }, [])

  const format = (n:number) => new Intl.NumberFormat('id-ID').format(Math.round(n||0))
  const abbreviate = (n:number) => {
    const abs = Math.abs(n)
    if (abs >= 1e9) return (n/1e9).toFixed(1).replace(/\.0$/, '') + 'B'
    if (abs >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    if (abs >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/, '') + 'K'
    return format(n)
  }
  const sizeFor = (n:number) => {
    const len = format(n).length
    if (len >= 12) return 'text-sm'
    if (len >= 10) return 'text-base'
    if (len >= 8) return 'text-lg'
    return 'text-xl'
  }
  const findUser = (label:string) => {
    const key = String(label||'').toLowerCase();
    return (users||[]).find((x:any)=> String(x.full_name||'').toLowerCase()===key || String(x.username||'').toLowerCase()===key);
  }
  const getAvatar = (label:string) => {
    const u = findUser(label);
    return u?.profile_picture_url || null;
  }
  const withTotal = rows.map(r => ({ ...r, total: r.total ?? (r.views + r.likes + r.comments + r.shares + (r as any).saves || 0) }))
  const top3 = withTotal.slice(0,3)
  const rest = withTotal.slice(3)
  const grandTotals = useMemo(() => {
    const acc = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    for (const r of rows) {
      acc.views += Number(r.views)||0;
      acc.likes += Number(r.likes)||0;
      acc.comments += Number(r.comments)||0;
      acc.shares += Number(r.shares)||0;
      acc.saves += Number(r.saves)||0;
    }
    return acc;
  }, [rows]);

  const countdown = useMemo(() => {
    const end = period?.end ? new Date(period.end + 'T23:59:59Z').getTime() : null;
    if (!end) return null;
    const diff = Math.max(0, end - now);
    const d = Math.floor(diff / (24*60*60*1000));
    const h = Math.floor((diff % (24*60*60*1000))/(60*60*1000));
    const m = Math.floor((diff % (60*60*1000))/(60*1000));
    const s = Math.floor((diff % (60*1000))/1000);
    const pad = (x:number)=> String(x).padStart(2,'0');
    return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  }, [period, now]);

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="mb-4">
        <div className="mb-3 flex items-center gap-3 text-xs flex-wrap">
          <span className="text-white/60">Periode:</span>
          <button className={`px-2 py-1 rounded ${interval==='days7'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('days7')}>7 hari</button>
          <button className={`px-2 py-1 rounded ${interval==='days28'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('days28')}>28 hari</button>
          
          <div className="ml-4 flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer text-white/80">
              <input 
                type="checkbox" 
                checked={useCustomDates} 
                onChange={(e)=>setUseCustomDates(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-xs">Custom Date</span>
            </label>
          </div>
          
          {useCustomDates && (
            <>
              <input
                type="date"
                value={customStart}
                onChange={(e)=>setCustomStart(e.target.value)}
                className="px-2 py-1 rounded bg-white/10 border border-white/20 text-white text-xs"
              />
              <span className="text-white/60">→</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e)=>setCustomEnd(e.target.value)}
                className="px-2 py-1 rounded bg-white/10 border border-white/20 text-white text-xs"
              />
            </>
          )}
        </div>
        {/* Header section (title / period / totals) intentionally removed per request */}
      </div>

      {loading ? (
        <div className="glass rounded-2xl border border-white/10 p-6 text-white/70">Loading…</div>
      ) : error ? (
        <div className="glass rounded-2xl border border-white/10 p-6 text-red-300">{error}</div>
      ) : (
        <>
              <div className="mb-4 flex flex-col sm:flex-row sm:flex-wrap md:flex-nowrap md:items-end md:justify-center gap-4 md:gap-6">
                {top3.map((r, i) => {
                  const prize = i===0? prizes?.first_prize : i===1? prizes?.second_prize : prizes?.third_prize;
                  const podiumCls = i===0? 'podium podium-gold' : i===1? 'podium podium-silver' : 'podium podium-bronze';
                  const rankCls = i===0? 'rank-3d rank-gold' : i===1? 'rank-3d rank-silver' : 'rank-3d rank-bronze';
                  const order = i===1? 'md:order-1' : i===0? 'md:order-2' : 'md:order-3';
                  const height = i===0? 'min-h-[260px] sm:min-h-[280px] md:min-h-[320px]' : 'min-h-[220px] sm:min-h-[240px] md:min-h-[260px]';
                  const width = i===0? 'w-full max-w-[480px] md:w-[380px]' : 'w-full max-w-[420px] md:w-[320px]';
                  const levelOffset = i===0? 'md:-mt-2' : 'md:mt-6';
                  return (
                    <div key={r.username} className={`${order} ${width} mx-auto ${levelOffset}`} onClick={()=>{ setSelectedName(r.username); setSelectedAvatar(getAvatar(r.username)); setSelectedRow(r); setSelectedUser(findUser(r.username)); }}>
                      <div className={`relative glass rounded-2xl ${podiumCls} ${height} p-6 border flex flex-col items-center justify-between`}>
                        <div className="mt-2">
                          <div className={`${rankCls} text-5xl sm:text-6xl md:text-7xl`}>{i+1}</div>
                        </div>
                        <div className="text-center">
                          {(() => { const url=getAvatar(r.username); return url? (<img src={url} alt="avatar" className="w-12 h-12 rounded-full object-cover border border-white/20 mx-auto mb-2" />): null })()}
                          <div className="text-xs sm:text-sm text-white/70">{r.username}</div>
                          {typeof prize === 'number' && (
                            <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-white/90">
                              <span className="text-[11px] sm:text-xs">Prize</span>
                              <span className="font-semibold text-sm">Rp. {new Intl.NumberFormat('id-ID').format(prize)}</span>
                            </div>
                          )}
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3 text-[11px] sm:text-xs w-full">
                          <div className="glass rounded-xl p-3 border border-white/10 min-w-0"><div className="text-white/60">Views</div><div className={`text-white ${sizeFor(r.views)} leading-tight tracking-tight`}>{abbreviate(r.views)}</div></div>
                          <div className="glass rounded-xl p-3 border border-white/10 min-w-0"><div className="text-white/60">Likes</div><div className={`text-white ${sizeFor(r.likes)} leading-tight tracking-tight`}>{abbreviate(r.likes)}</div></div>
                          <div className="glass rounded-xl p-3 border border-white/10 min-w-0"><div className="text-white/60">Comments</div><div className={`text-white ${sizeFor(r.comments)} leading-tight tracking-tight`}>{abbreviate(r.comments)}</div></div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs sm:text-sm text-white/70 w-full">
                          <div>Shares: <span className="text-white">{format(r.shares)}</span></div>
                          <div>Total: <span className="text-white font-medium">{format(r.total!)}</span></div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {period && period.end && (
                <div className="mb-8 text-center">
                  <span className="text-white/80 mr-2">Ends in</span>
                  <span className="text-white font-semibold">{countdown}</span>
                </div>
              )}
            

          <div className="glass rounded-2xl border border-white/10 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-white/60 bg-white/5">
                  <th className="py-3 px-4">#</th>
                  <th className="py-3 px-4">Karyawan</th>
                  <th className="py-3 px-4">Views</th>
                  <th className="py-3 px-4">Likes</th>
                  <th className="py-3 px-4">Comments</th>
                  <th className="py-3 px-4">Shares</th>
                  {/* Saves removed */}
                  <th className="py-3 px-4">Total</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((r, i) => (
                  <tr key={r.username} className="border-t border-white/10 hover:bg-white/5 cursor-pointer" onClick={()=>{ setSelectedName(r.username); setSelectedAvatar(getAvatar(r.username)); setSelectedRow(r); setSelectedUser(findUser(r.username)); }}>
                    <td className="py-2 px-4 text-white/60">{i+4}</td>
                    <td className="py-2 px-4 text-white/90 flex items-center gap-2">
                      {(() => { const url=getAvatar(r.username); return url? (<img src={url} alt="avatar" className="w-6 h-6 rounded-full object-cover border border-white/20" />): (<span className="w-6 h-6 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-[10px] text-white/70">{r.username.charAt(0).toUpperCase()}</span>) })()}
                      <span>{r.username}</span>
                    </td>
                    <td className="py-2 px-4 text-white/80">{format(r.views)}</td>
                    <td className="py-2 px-4 text-white/80">{format(r.likes)}</td>
                    <td className="py-2 px-4 text-white/80">{format(r.comments)}</td>
                    <td className="py-2 px-4 text-white/80">{format(r.shares)}</td>
                    {/* Saves removed */}
                    <td className="py-2 px-4 text-white/90 font-medium">{format(r.total!)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td className="py-4 px-4 text-white/60" colSpan={7}>Tidak ada data.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {selectedName && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={()=>{ setSelectedName(null); setSelectedAvatar(null); setSelectedRow(null); setSelectedUser(null); }}>
              <div className="glass rounded-2xl border border-white/10 w-full max-w-md p-6" onClick={(e)=>e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    {(() => {
                      const tts: string[] = Array.from(new Set([selectedUser?.tiktok_username, ...((selectedUser?.extra_tiktok_usernames||[]) as string[])]).values()).filter(Boolean) as string[];
                      const igs: string[] = Array.from(new Set([selectedUser?.instagram_username, ...((selectedUser?.extra_instagram_usernames||[]) as string[])]).values()).filter(Boolean) as string[];
                      const AvatarEl = selectedAvatar ? (
                        <img src={selectedAvatar} alt="avatar" className="w-12 h-12 rounded-full object-cover border border-white/20 cursor-pointer" onClick={()=> setShowAvatarCard(true)} />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-white/70">
                          {selectedName.charAt(0).toUpperCase()}
                        </div>
                      );
                      return AvatarEl;
                    })()}
                    <h3 className="text-lg font-semibold text-white">{selectedName}</h3>
                  </div>
                  <button className="text-white/70 hover:text-white" onClick={()=>{ setSelectedName(null); setSelectedAvatar(null); setSelectedRow(null); }}>✕</button>
                </div>
                {selectedRow && (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="glass rounded-xl p-3 border border-white/10"><div className="text-white/60">Views</div><div className="text-white text-lg">{new Intl.NumberFormat('id-ID').format(Math.round(selectedRow.views||0))}</div></div>
                    <div className="glass rounded-xl p-3 border border-white/10"><div className="text-white/60">Likes</div><div className="text-white text-lg">{new Intl.NumberFormat('id-ID').format(Math.round(selectedRow.likes||0))}</div></div>
                    <div className="glass rounded-xl p-3 border border-white/10"><div className="text-white/60">Comments</div><div className="text-white text-lg">{new Intl.NumberFormat('id-ID').format(Math.round(selectedRow.comments||0))}</div></div>
                    <div className="glass rounded-xl p-3 border border-white/10"><div className="text-white/60">Shares</div><div className="text-white text-lg">{new Intl.NumberFormat('id-ID').format(Math.round(selectedRow.shares||0))}</div></div>
                  </div>
                )}
                {selectedUser && (
                  <div className="mt-4 text-sm">
                    <div className="text-white/60 mb-2">Profiles</div>
                    <div className="flex items-center gap-3 flex-wrap">
                      {(() => {
                        const tts: string[] = Array.from(new Set([selectedUser.tiktok_username, ...((selectedUser.extra_tiktok_usernames||[]) as string[])]).values()).filter(Boolean) as string[];
                        return tts.map((u:string, idx:number)=> (
                          <a key={`tt-${u}-${idx}`} href={`https://www.tiktok.com/@${u}`} target="_blank" rel="noreferrer" className="px-3 py-1 rounded-lg border border-white/10 bg-white/5 text-white/80 hover:text-white hover:bg-white/10">TikTok @{u}</a>
                        ));
                      })()}
                      {(() => {
                        const igs: string[] = Array.from(new Set([selectedUser.instagram_username, ...((selectedUser.extra_instagram_usernames||[]) as string[])]).values()).filter(Boolean) as string[];
                        return igs.map((u:string, idx:number)=> (
                          <a key={`ig-${u}-${idx}`} href={`https://www.instagram.com/${u}/`} target="_blank" rel="noreferrer" className="px-3 py-1 rounded-lg border border-white/10 bg-white/5 text-white/80 hover:text-white hover:bg-white/10">Instagram @{u}</a>
                        ));
                      })()}
                    </div>
                  </div>
                )}
                {selectedUser && (
                  <div className="mt-4 text-sm">
                    <div className="text-white/60 mb-2">Di grup mana</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {(() => {
                        const names = employeeGroups[String(selectedUser.id)] || [];
                        return (names.length? names : ['(hanya grup aktif)']).map((g:string, idx:number)=> (
                          <span key={`grp-${idx}`} className="px-3 py-1 rounded-lg border border-white/10 bg-white/5 text-white/80">{g}</span>
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {showAvatarCard && selectedAvatar && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70" onClick={()=> setShowAvatarCard(false)}>
              <div className="relative" onClick={(e)=>e.stopPropagation()}>
                <img src={selectedAvatar} alt="avatar-large" className="max-w-[80vw] max-h-[80vh] rounded-2xl object-contain shadow-2xl border border-white/20" />
                <button className="absolute -top-3 -right-3 bg-white/10 hover:bg-white/20 text-white rounded-full w-8 h-8" onClick={()=> setShowAvatarCard(false)}>✕</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Top Viral Videos Section removed as requested */}
    </div>
  )
}
