'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { User } from '@/types';
import { FaEdit, FaTrash, FaPlus, FaTimes } from 'react-icons/fa';

export default function AdminPage() {
  const supabase = createClient();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Prizes state (active campaign)
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [firstPrize, setFirstPrize] = useState<number>(0);
  const [secondPrize, setSecondPrize] = useState<number>(0);
  const [thirdPrize, setThirdPrize] = useState<number>(0);
  const [savingPrizes, setSavingPrizes] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [currentUser, setCurrentUser] = useState<Partial<User> & { email?: string } | null>(null);
  const [password, setPassword] = useState('');
  const [showPasswordField, setShowPasswordField] = useState(false);
  // Tag inputs for TikTok & Instagram
  const [tikTags, setTikTags] = useState<string[]>([]);
  const [igTags, setIgTags] = useState<string[]>([]);
  const [tikInput, setTikInput] = useState('');
  const [igInput, setIgInput] = useState('');
  const [searchName, setSearchName] = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/get-users');
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Gagal memuat data Karyawan.');
      }
      const data = await response.json();
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    // load active campaign and prizes
    (async () => {
      try {
        const res = await fetch('/api/leaderboard');
        const j = await res.json();
        if (res.ok && j?.campaignId) {
          setActiveCampaignId(j.campaignId);
          if (j?.prizes) {
            setFirstPrize(Number(j.prizes.first_prize)||0);
            setSecondPrize(Number(j.prizes.second_prize)||0);
            setThirdPrize(Number(j.prizes.third_prize)||0);
          } else {
            const rp = await fetch(`/api/campaigns/${j.campaignId}/prizes`);
            const pj = await rp.json();
            if (rp.ok) {
              setFirstPrize(Number(pj.first_prize)||0);
              setSecondPrize(Number(pj.second_prize)||0);
              setThirdPrize(Number(pj.third_prize)||0);
            }
          }
        }
      } catch {}
    })();
  }, []);

  const savePrizes = async () => {
    if (!activeCampaignId) return;
    setSavingPrizes(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${activeCampaignId}/prizes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_prize: firstPrize, second_prize: secondPrize, third_prize: thirdPrize })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Gagal menyimpan hadiah');
    } catch (e: any) {
      setError(e?.message || 'Gagal menyimpan hadiah');
    } finally {
      setSavingPrizes(false);
    }
  };

  const openModalForCreate = () => {
    setIsEditing(false);
    setCurrentUser({ role: 'karyawan' });
    setPassword('');
    setShowPasswordField(true); // create needs password
    setTikTags([]); setIgTags([]); setTikInput(''); setIgInput('');
    setShowModal(true);
  };

  const openModalForEdit = (user: User) => {
    setIsEditing(true);
    setCurrentUser(user);
    setPassword('');
    setShowPasswordField(false); // hidden by default on edit
    // Pre-fill multi usernames (primary + extras) into tags
    const extras: string[] = (user as any).extra_tiktok_usernames || [];
    const prim = user.tiktok_username ? [String(user.tiktok_username)] : [];
    const all = [...prim, ...extras].map((u:string)=> String(u).replace(/^@/, '').toLowerCase()).filter(Boolean);
    setTikTags(Array.from(new Set(all)));
    const igExtras: string[] = (user as any).extra_instagram_usernames || [];
    const igPrim = (user as any).instagram_username ? [String((user as any).instagram_username)] : [];
    const allIG = [...igPrim, ...igExtras].map((u:string)=> String(u).replace(/^@/, '').toLowerCase()).filter(Boolean);
    setIgTags(Array.from(new Set(allIG)));
    setTikInput(''); setIgInput('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setCurrentUser(null);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/manage-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isEditing,
          userData: {
            ...currentUser,
            tiktok_username: tikTags[0] || '',
            tiktok_usernames: tikTags,
            instagram_username: igTags[0] || '',
            instagram_usernames: igTags,
          },
          password: password || null,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Terjadi kesalahan pada server.');
      }

      await loadUsers();
      closeModal();
    } catch (err: any) {
      setError(err.message);
      console.error('Error submitting form:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (userId: string) => {
    if (!window.confirm('Apakah Anda yakin ingin menghapus Karyawan ini? Tindakan ini tidak dapat dibatalkan.')) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/manage-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isDeleting: true,
          userId,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Terjadi kesalahan pada server.');
      }
      
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
      console.error('Error deleting user:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setCurrentUser(prev => prev ? { ...prev, [name]: value } : null);
  };

  // Backfill messages / details (used by group backfill)
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  const [backfillDetail, setBackfillDetail] = useState<any | null>(null);

  // Global Refresh All (tanpa campaign)
  const [campaignBackfilling, setCampaignBackfilling] = useState(false);
  const runActiveCampaignBackfill = async () => {
    if (!confirm('Refresh semua akun (TikTok & Instagram). Proses bisa memakan waktu. Lanjutkan?')) return;
    setCampaignBackfilling(true);
    setBackfillMsg(null); setBackfillDetail(null);
    try {
      const res = await fetch('/api/refresh-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const j = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(j?.error || 'Refresh All gagal');
      setBackfillMsg(`Refresh All selesai. Akun diproses: ${j.updated || 0}`);
      setBackfillDetail(j);
    } catch (e:any) {
      setBackfillMsg(e?.message || 'Refresh All gagal');
    } finally {
      setCampaignBackfilling(false);
    }
  };

  // Instagram tools: Resolve IG user_ids + optional fetch
  const [resolvingIG, setResolvingIG] = useState(false);
  const [resolveMsg, setResolveMsg] = useState<string | null>(null);
  const [resolveDetail, setResolveDetail] = useState<any | null>(null);
  const [resolveLimit, setResolveLimit] = useState<number>(1000);
  const [resolveFetch, setResolveFetch] = useState<boolean>(false);
  const [resolveForce, setResolveForce] = useState<boolean>(false);
  const runResolveIG = async () => {
    if (!confirm('Jalankan resolusi Instagram user_id untuk semua username yang dikenal?')) return;
    setResolvingIG(true); setResolveMsg(null); setResolveDetail(null);
    try {
      const res = await fetch('/api/admin/ig/resolve-user-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: resolveLimit, fetch: resolveFetch, force: resolveForce })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Gagal resolve user_id');
      setResolveMsg(`Resolved: ${j.resolved || 0} dari ${j.users || 0} pengguna. Fetch triggered: ${j.fetched || 0}. Failures: ${j.failures || 0}`);
      setResolveDetail(j);
    } catch (e:any) {
      setResolveMsg(e?.message || 'Gagal resolve user_id');
    } finally {
      setResolvingIG(false);
    }
  };

  // Smart batch refresh for Instagram with auto-continuation
  const [refreshingIG, setRefreshingIG] = useState(false);
  const [igProgress, setIgProgress] = useState<{current: number; total: number; success: number; failed: number} | null>(null);
  const [igResults, setIgResults] = useState<any>(null);
  const [showIgContinueDialog, setShowIgContinueDialog] = useState(false);
  const [igOffset, setIgOffset] = useState(0); // Track batch offset
  const [igBatchSession, setIgBatchSession] = useState({
    totalSuccess: 0,
    totalFailed: 0,
    processed: new Set<string>()
  });
  const [autoIGMode, setAutoIGMode] = useState(false); // AUTO-CONTINUE MODE

  const runIGBatch = async (continueSession = false, customOffset?: number) => {
    setRefreshingIG(true);
    setShowIgContinueDialog(false);
    
    if (!continueSession) {
      setIgOffset(0);
      setIgResults(null);
      setIgProgress(null);
      setIgBatchSession({ totalSuccess: 0, totalFailed: 0, processed: new Set<string>() });
    }

    try {
      // CRITICAL: Use customOffset from auto-continue to avoid React state async issue
      const currentOffset = customOffset !== undefined ? customOffset : (continueSession ? igOffset : 0);
      console.log('[Instagram Refresh] Starting refresh');
      console.log('[Instagram Refresh] Using offset:', currentOffset);
      console.log('[Instagram Refresh] Auto mode:', autoIGMode ? 'ENABLED (will process ALL batches)' : 'DISABLED (single batch)');
      
      const res = await fetch('/api/admin/ig/refresh-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          offset: currentOffset,
          // Fetch ALL usernames (with or without resolved user_id). The fetch-ig route
          // can resolve/derive user IDs and also supports username-based fallback.
          only_with_user_id: false,
          include_details: true,
          auto_continue: autoIGMode // Send flag to server (though server ignores it now)
        })
      });
      
      // Handle non-JSON responses (errors)
      const contentType = res.headers.get('content-type');
      let j: any;
      if (contentType && contentType.includes('application/json')) {
        j = await res.json();
      } else {
        const text = await res.text();
        throw new Error(`Server error (${res.status}): ${text.substring(0, 200)}`);
      }
      
      if (!res.ok) throw new Error(j?.error || 'Gagal refresh Instagram');

      // Update offset for next batch
      const nextOffset = j.next_offset || igOffset;
      if (j.next_offset) {
        setIgOffset(j.next_offset);
      }
      
      setIgResults(j);
      setIgProgress({
        current: j.total_processed || 0, 
        total: j.usernames_with_ids || 0, 
        success: j.success || 0, 
        failed: j.failed || 0
      });

      // Update batch session stats
      setIgBatchSession(prev => ({
        totalSuccess: prev.totalSuccess + (j.success || 0),
        totalFailed: prev.totalFailed + (j.failed || 0),
        processed: new Set([...prev.processed, ...(j.processed_usernames || [])])
      }));

      // Show message if provided
      if (j.message) {
        console.log('[Instagram Refresh]', j.message);
      }

      // AUTO-CONTINUE MODE: Automatically continue to next batch
      if (j.remaining > 0) {
        if (autoIGMode) {
          console.log(`[AUTO MODE IG] ${j.remaining} accounts remaining, continuing in 2 seconds with offset=${nextOffset}...`);
          // CRITICAL FIX: Pass nextOffset directly as parameter to avoid React state async issue
          setTimeout(() => {
            setIgOffset(nextOffset); // Update state for UI display
            runIGBatch(true, nextOffset); // Pass offset directly to avoid stale closure
          }, 2000);
        } else {
          setShowIgContinueDialog(true);
        }
      } else {
        setAutoIGMode(false); // Reset auto mode
        alert(`✅ Semua ${j.usernames_with_ids} akun Instagram berhasil di-refresh!\n\nSuccess: ${igBatchSession.totalSuccess + (j.success || 0)}\nFailed: ${igBatchSession.totalFailed + (j.failed || 0)}`);
        setIgOffset(0); // Reset for next full refresh
      }
    } catch (e: any) {
      setAutoIGMode(false); // Stop auto mode on error
      alert('Error: ' + (e?.message || 'Gagal refresh Instagram'));
    } finally {
      setRefreshingIG(false);
    }
  };

  // Smart batch refresh for TikTok with offset tracking
  const [refreshingTikTok, setRefreshingTikTok] = useState(false);
  const [tikTokProgress, setTikTokProgress] = useState<{current: number; total: number; success: number; failed: number} | null>(null);
  const [tikTokResults, setTikTokResults] = useState<any>(null);
  const [showTikTokContinueDialog, setShowTikTokContinueDialog] = useState(false);
  const [tikTokOffset, setTikTokOffset] = useState(0); // Track batch offset
  const [tikTokBatchSession, setTikTokBatchSession] = useState({
    totalSuccess: 0,
    totalFailed: 0,
    processed: new Set<string>()
  });
  const [autoTikTokMode, setAutoTikTokMode] = useState(false); // AUTO-CONTINUE MODE

  // Backfill taken_at state
  const [runningTakenAt, setRunningTakenAt] = useState(false);
  const [takenAtResult, setTakenAtResult] = useState<any>(null);
  const [takenAtPlatform, setTakenAtPlatform] = useState<'instagram' | 'tiktok' | 'all'>('instagram');
  const [runningAccrual, setRunningAccrual] = useState(false);
  const [accrualDays, setAccrualDays] = useState<number>(60);
  
  const runTakenAtBackfill = async () => {
    if (!confirm(`Backfill taken_at untuk ${takenAtPlatform === 'all' ? 'Instagram & TikTok' : takenAtPlatform}?\nProses bisa memakan waktu 5-10 menit.`)) return;
    
    setRunningTakenAt(true);
    setTakenAtResult(null);
    
    try {
      const res = await fetch(`/api/backfill/taken-at?platform=${takenAtPlatform}&limit=200`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Gagal backfill taken_at');
      
      setTakenAtResult(j);
      alert(`✅ Backfill taken_at selesai!\n\nPlatform: ${j.platform || takenAtPlatform}\nUpdated: ${j.updated || 0}\nFailed: ${j.failed || 0}`);
    } catch (e: any) {
      alert('Error: ' + (e?.message || 'Gagal backfill taken_at'));
    } finally {
      setRunningTakenAt(false);
    }
  };

  const runAccrualBackfill = async () => {
    if (!confirm(`Backfill accrual ${accrualDays} hari ke belakang?
Ini akan menulis snapshot harian ke social_metrics_history.`)) return;
    setRunningAccrual(true);
    try {
      const res = await fetch('/api/backfill/accrual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: accrualDays })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Backfill accrual gagal');
      alert(`✅ Backfill accrual selesai!\n\nInserted: ${j.inserted || j.updated || 0}\nRange: ${j?.range ? `${j.range.start} s/d ${j.range.end}` : ''}`);
    } catch (e:any) {
      alert('Error: ' + (e?.message || 'Backfill accrual gagal'));
    } finally { setRunningAccrual(false); }
  };

  const runTikTokBatch = async (continueSession = false, customOffset?: number) => {
    // Selalu gunakan admin/tiktok/refresh-all agar alurnya identik dengan Instagram
    setRefreshingTikTok(true);
    setShowTikTokContinueDialog(false);
    
    if (!continueSession) {
      setTikTokOffset(0);
      setTikTokResults(null);
      setTikTokProgress(null);
      setTikTokBatchSession({ totalSuccess: 0, totalFailed: 0, processed: new Set<string>() });
    }

    try {
      // CRITICAL: Use customOffset from auto-continue to avoid React state async issue
      const currentOffset = customOffset !== undefined ? customOffset : (continueSession ? tikTokOffset : 0);
      console.log('[TikTok Refresh] Starting refresh-all (campaign-agnostic)');
      console.log('[TikTok Refresh] Using offset:', currentOffset);
      console.log('[TikTok Refresh] Auto mode:', autoTikTokMode ? 'ENABLED (will process ALL batches)' : 'DISABLED (single batch)');
      
      const res = await fetch('/api/admin/tiktok/refresh-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          offset: currentOffset,
          include_details: true,
          auto_continue: autoTikTokMode // CRITICAL: Enable unlimited batch processing in Auto mode
        })
      });
      
      console.log('[TikTok Refresh] Response status:', res.status);
      console.log('[TikTok Refresh] Content-Type:', res.headers.get('content-type'));
      
      // Handle non-JSON responses (errors)
      const contentType = res.headers.get('content-type');
      let j: any;
      if (contentType && contentType.includes('application/json')) {
        j = await res.json();
        console.log('[TikTok Refresh] Response data:', j);
      } else {
        const text = await res.text();
        console.error('[TikTok Refresh] Non-JSON response:', text.substring(0, 500));
        throw new Error(`Server error (${res.status}): ${text.substring(0, 200)}`);
      }
      
      if (!res.ok) throw new Error(j?.error || 'Gagal refresh TikTok');

      // Update offset for next batch
      const nextOffset = j.next_offset || tikTokOffset;
      if (j.next_offset) {
        setTikTokOffset(j.next_offset);
      }
      
      setTikTokResults(j);
      setTikTokProgress({
        current: j.total_processed || 0, 
        total: j.total_usernames || 0, 
        success: j.success || 0, 
        failed: j.failed || 0
      });

      // Update batch session stats
      setTikTokBatchSession(prev => ({
        totalSuccess: prev.totalSuccess + (j.success || 0),
        totalFailed: prev.totalFailed + (j.failed || 0),
        processed: new Set([...prev.processed, ...(j.processed_usernames || [])])
      }));

      // Show message if provided
      if (j.message) {
        console.log('[TikTok Refresh]', j.message);
      }

      // AUTO-CONTINUE MODE: Automatically continue to next batch
      if (j.remaining > 0) {
        if (autoTikTokMode) {
          console.log(`[AUTO MODE] ${j.remaining} accounts remaining, continuing in 2 seconds with offset=${nextOffset}...`);
          // CRITICAL FIX: Pass nextOffset directly as parameter to avoid React state async issue
          setTimeout(() => {
            setTikTokOffset(nextOffset); // Update state for UI display
            runTikTokBatch(true, nextOffset); // Pass offset directly to avoid stale closure
          }, 2000);
        } else {
          setShowTikTokContinueDialog(true);
        }
      } else {
        setAutoTikTokMode(false); // Reset auto mode
        alert(`✅ Semua ${j.total_usernames} akun TikTok berhasil di-refresh!\n\nSuccess: ${tikTokBatchSession.totalSuccess + (j.success || 0)}\nFailed: ${tikTokBatchSession.totalFailed + (j.failed || 0)}`);
        setTikTokOffset(0); // Reset for next full refresh
      }
    } catch (e: any) {
      console.error('[TikTok Refresh] Error caught:', e);
      setAutoTikTokMode(false); // Stop auto mode on error
      alert('Error: ' + (e?.message || 'Gagal refresh TikTok'));
    } finally {
      setRefreshingTikTok(false);
    }
  };

  return (
    <div className="p-8 min-h-screen">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-semibold tracking-tight bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">Manajemen Karyawan</h1>
        <div className="flex items-center gap-3">
          {/* Platform selector for taken_at backfill */}
          <select
            value={takenAtPlatform}
            onChange={(e) => setTakenAtPlatform(e.target.value as 'instagram' | 'tiktok' | 'all')}
            className="rounded-lg px-3 py-2 bg-gray-800 text-white border border-white/20 text-sm"
          >
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
            <option value="all">Semua</option>
          </select>
          <button 
            onClick={runTakenAtBackfill}
            disabled={runningTakenAt || refreshingTikTok || refreshingIG}
            className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 bg-gradient-to-r from-purple-600 to-purple-700 text-white shadow-lg hover:shadow-xl transition-all border border-white/10 disabled:opacity-50"
            title="Backfill taken_at (tanggal upload video) untuk posts yang belum ada"
          >
            <span className="text-lg">📅</span>
            <span className="font-medium">{runningTakenAt ? 'Processing...' : 'Backfill Taken At'}</span>
          </button>
          {/* Backfill accrual snapshots */}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={7}
              max={180}
              value={accrualDays}
              onChange={(e)=> setAccrualDays(Math.max(7, Math.min(180, Number(e.target.value||60))))}
              className="w-20 rounded-lg px-3 py-2 bg-gray-800 text-white border border-white/20 text-sm"
              title="Jumlah hari backfill accrual"
            />
            <button
              onClick={runAccrualBackfill}
              disabled={runningAccrual || refreshingTikTok || refreshingIG}
              className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow-lg hover:shadow-xl transition-all border border-white/10 disabled:opacity-50"
              title="Backfill snapshot accrual ke social_metrics_history"
            >
              <span className="text-lg">🧮</span>
              <span className="font-medium">{runningAccrual ? 'Backfilling…' : 'Backfill Accrual'}</span>
            </button>
          </div>
          {/* TikTok refresh controls */}
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                setAutoTikTokMode(true); // AUTO MODE - NO STOP!
                runTikTokBatch(false);
              }} 
              disabled={refreshingTikTok}
              className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-green-600 text-white shadow-lg hover:shadow-xl transition-all disabled:opacity-50 animate-pulse"
              title="AUTO MODE: Refresh semua akun tanpa henti sampai selesai!"
            >
              <span className="text-lg">🚀</span>
              <span className="font-medium">{autoTikTokMode ? '⚡ AUTO RUNNING...' : '⚡ AUTO ALL'}</span>
            </button>
          </div>
          {/* Manual Instagram refresh hidden per request */}
          <button 
            onClick={() => {
              setAutoIGMode(true); // AUTO MODE - NO STOP!
              runIGBatch(false);
            }} 
            disabled={refreshingIG}
            className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 bg-gradient-to-r from-orange-600 to-red-600 text-white shadow-lg hover:shadow-xl transition-all disabled:opacity-50 animate-pulse"
            title="AUTO MODE: Refresh semua akun Instagram tanpa henti sampai selesai!"
          >
            <span className="text-lg">🚀</span>
            <span className="font-medium">{autoIGMode ? '⚡ AUTO RUNNING...' : '⚡ AUTO ALL IG'}</span>
          </button>
          <button 
            onClick={runResolveIG} 
            disabled={resolvingIG}
            className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 bg-gradient-to-r from-blue-600 to-cyan-600 text-white shadow-lg hover:shadow-xl transition-all disabled:opacity-50"
          >
            <span className="text-lg">🔍</span>
            <span className="font-medium">{resolvingIG ? 'Resolving...' : 'Resolve Akun Instagram'}</span>
          </button>
          <button onClick={openModalForCreate} className="inline-flex items-center gap-2 rounded-xl px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-500 text-white shadow-lg shadow-emerald-600/20">
            <FaPlus />
            <span>Tambah Karyawan</span>
          </button>
        </div>
      </div>

      {/* Progress Indicators */}
      {(igProgress || tikTokProgress || resolveMsg) && (
        <div className="mb-6 space-y-3">
          {igProgress && (
            <div className="glass rounded-xl border border-pink-500/30 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">📸</span>
                  <h3 className="font-semibold text-white">Instagram Progress</h3>
                </div>
                <span className="text-sm text-white/70">{igProgress.current} akun diproses</span>
              </div>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-2">
                  <div className="text-xs text-green-300/70">Berhasil</div>
                  <div className="text-xl font-bold text-green-400">{igProgress.success}</div>
                </div>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2">
                  <div className="text-xs text-red-300/70">Gagal</div>
                  <div className="text-xl font-bold text-red-400">{igProgress.failed}</div>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-2">
                  <div className="text-xs text-blue-300/70">Total</div>
                  <div className="text-xl font-bold text-blue-400">{igProgress.total}</div>
                </div>
              </div>
              {igResults && (
                <div className="text-xs text-white/60 space-y-1">
                  <div>📊 Posts: {igResults.total_posts_inserted?.toLocaleString()} | Views: {igResults.total_views?.toLocaleString()} | Likes: {igResults.total_likes?.toLocaleString()}</div>
                  <div>⚡ Avg: {igResults.avg_duration_ms}ms/akun</div>
                </div>
              )}
            </div>
          )}
          {tikTokProgress && tikTokProgress.current > 0 && (
            <div className="glass rounded-xl border border-gray-500/30 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">🎵</span>
                  <h3 className="font-semibold text-white">TikTok Progress</h3>
                </div>
                <span className="text-sm text-white/70">{tikTokProgress.current} akun diproses</span>
              </div>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-2">
                  <div className="text-xs text-green-300/70">Berhasil</div>
                  <div className="text-xl font-bold text-green-400">{tikTokProgress.success}</div>
                </div>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2">
                  <div className="text-xs text-red-300/70">Gagal</div>
                  <div className="text-xl font-bold text-red-400">{tikTokProgress.failed}</div>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-2">
                  <div className="text-xs text-blue-300/70">Total</div>
                  <div className="text-xl font-bold text-blue-400">{tikTokProgress.total}</div>
                </div>
              </div>
              {tikTokResults && (
                <div className="text-xs text-white/60 space-y-1">
                  <div>📊 Posts: {tikTokResults.total_posts_inserted?.toLocaleString?.() || tikTokResults.total_posts_inserted} | Views: {tikTokResults.total_views?.toLocaleString?.() || tikTokResults.total_views} | Likes: {tikTokResults.total_likes?.toLocaleString?.() || tikTokResults.total_likes}</div>
                  <div>⚡ Avg: {tikTokResults.avg_duration_ms}ms/akun</div>
                </div>
              )}
            </div>
          )}
          {resolveMsg && (
            <div className="glass rounded-xl border border-blue-500/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">🔍</span>
                <h3 className="font-semibold text-white">Resolve Instagram User IDs</h3>
              </div>
              <div className="text-sm text-white/80">{resolveMsg}</div>
            </div>
          )}
        </div>
      )}

      {/* Instagram Continue Dialog */}
      {showIgContinueDialog && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="glass border border-pink-500/30 p-8 rounded-2xl max-w-lg w-full glow-border">
            <div className="text-center mb-6">
              <div className="text-6xl mb-4">📸</div>
              <h2 className="text-2xl font-bold text-white mb-2">Batch Instagram Selesai!</h2>
              <p className="text-white/70">Ada akun Instagram yang belum ter-fetch.</p>
            </div>
            
            <div className="bg-white/5 rounded-xl p-4 mb-6 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Berhasil:</span>
                <span className="text-green-400 font-bold">{igBatchSession.totalSuccess} akun</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Gagal:</span>
                <span className="text-red-400 font-bold">{igBatchSession.totalFailed} akun</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Sudah Diproses:</span>
                <span className="text-blue-400 font-bold">{igBatchSession.processed.size} akun</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Total Akun:</span>
                <span className="text-white font-bold">{igResults?.total_usernames || 0} akun</span>
              </div>
            </div>

            <p className="text-center text-white/80 mb-6">Lanjut fetch batch berikutnya?</p>
            
            <div className="flex gap-3">
              <button
                onClick={() => setShowIgContinueDialog(false)}
                className="flex-1 px-6 py-3 rounded-xl border border-white/20 text-white hover:bg-white/5 transition-all"
              >
                Selesai
              </button>
              <button
                onClick={() => runIGBatch(true)}
                className="flex-1 px-6 py-3 rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 text-white font-semibold shadow-lg hover:shadow-xl transition-all"
              >
                Ya, Lanjutkan! 🚀
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TikTok Continue Dialog */}
      {showTikTokContinueDialog && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="glass border border-gray-500/30 p-8 rounded-2xl max-w-lg w-full glow-border">
            <div className="text-center mb-6">
              <div className="text-6xl mb-4">🎵</div>
              <h2 className="text-2xl font-bold text-white mb-2">Batch TikTok Selesai!</h2>
              <p className="text-white/70">Ada akun TikTok yang belum ter-fetch.</p>
            </div>
            
            <div className="bg-white/5 rounded-xl p-4 mb-6 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Berhasil:</span>
                <span className="text-green-400 font-bold">{tikTokBatchSession.totalSuccess} akun</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Gagal:</span>
                <span className="text-red-400 font-bold">{tikTokBatchSession.totalFailed} akun</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Sudah Diproses:</span>
                <span className="text-blue-400 font-bold">{tikTokBatchSession.processed.size} akun</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Total Akun:</span>
                <span className="text-white font-bold">{tikTokResults?.total_usernames || 0} akun</span>
              </div>
            </div>

            <p className="text-center text-white/80 mb-6">Lanjut fetch batch berikutnya?</p>
            
            <div className="flex gap-3">
              <button
                onClick={() => setShowTikTokContinueDialog(false)}
                className="flex-1 px-6 py-3 rounded-xl border border-white/20 text-white hover:bg-white/5 transition-all"
              >
                Selesai
              </button>
              <button
                onClick={() => runTikTokBatch(true)}
                className="flex-1 px-6 py-3 rounded-xl bg-gradient-to-r from-gray-700 to-gray-900 text-white font-semibold shadow-lg hover:shadow-xl transition-all"
              >
                Ya, Lanjutkan! 🚀
              </button>
            </div>
          </div>
        </div>
      )}

      {backfillMsg && (
        <div className="mb-4 text-sm text-white/80">
          <div>{backfillMsg}</div>
          {backfillDetail && (
            <details className="mt-2">
              <summary className="cursor-pointer text-white/70">Lihat detail</summary>
              <pre className="mt-2 max-h-64 overflow-auto text-xs bg-black/40 p-3 rounded border border-white/10 text-white/80">{JSON.stringify(backfillDetail, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {/* Edit Hadiah Leaderboard (Active Campaign) */}
      <div className="glass rounded-2xl border border-white/10 p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">Set Hadiah Juara</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-white/70 mb-1">Juara 1</label>
            <input type="number" value={firstPrize} onChange={e=>setFirstPrize(Number(e.target.value||0))} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" />
          </div>
          <div>
            <label className="block text-sm text-white/70 mb-1">Juara 2</label>
            <input type="number" value={secondPrize} onChange={e=>setSecondPrize(Number(e.target.value||0))} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" />
          </div>
          <div>
            <label className="block text-sm text-white/70 mb-1">Juara 3</label>
            <input type="number" value={thirdPrize} onChange={e=>setThirdPrize(Number(e.target.value||0))} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={savePrizes} disabled={!activeCampaignId || savingPrizes} className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 text-white disabled:opacity-50">
            {savingPrizes ? 'Menyimpan…' : 'Simpan Hadiah'}
          </button>
        </div>
      </div>

      {loading && <p className="text-white/60">Memuat...</p>}

      <div className="glass rounded-2xl border border-white/10 overflow-x-auto">
        <div className="p-4 flex items-center gap-3">
          <input
            value={searchName}
            onChange={(e)=> setSearchName(e.target.value)}
            placeholder="Cari nama lengkap…"
            className="w-full max-w-md px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white"
          />
        </div>
        <table className="min-w-full">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-white/60">
              <th className="px-6 py-3">Nama Lengkap</th>
              <th className="px-6 py-3">Username</th>
              <th className="px-6 py-3">TikTok Usernames</th>
              <th className="px-6 py-3">Instagram Usernames</th>
              <th className="px-6 py-3">Peran</th>
              <th className="px-6 py-3">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {users.filter(u => !searchName || String(u.full_name||'').toLowerCase().includes(searchName.toLowerCase())).map(user => (
              <tr key={user.id} className="border-t border-white/10 hover:bg-white/5">
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white/90">{user.full_name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white/70">{user.username}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white/70">{[user.tiktok_username, ...(((user as any).extra_tiktok_usernames)||[])].filter(Boolean).join(', ') || '-'}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-white/70">{[((user as any).instagram_username), ...(((user as any).extra_instagram_usernames)||[])].filter(Boolean).join(', ') || '-'}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full border ${
                    user.role === 'admin' ? 'border-red-500/30 text-red-300 bg-red-500/10' : user.role === 'leader' ? 'border-yellow-400/30 text-yellow-300 bg-yellow-400/10' : 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
                  }`}>
                    {user.role === 'super_admin' ? 'super admin' : user.role === 'leader' ? 'Leader' : user.role}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <button onClick={() => openModalForEdit(user)} className="text-blue-300 hover:text-blue-200 mr-4">
                    <FaEdit />
                  </button>
                  <button onClick={() => handleDelete(user.id)} className="text-red-300 hover:text-red-200">
                    <FaTrash />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex justify-center items-center z-50 p-4" onClick={closeModal}>
          <div className="glass border border-white/10 p-8 rounded-2xl w-full max-w-2xl glow-border" onClick={(e)=>e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-semibold bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">{isEditing ? 'Edit Karyawan' : 'Tambah Karyawan Baru'}</h2>
              <button type="button" onClick={closeModal} className="text-white/60 hover:text-white">
                <FaTimes size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              {error && <p className="text-red-300 bg-red-500/10 border border-red-500/30 p-3 rounded-md mb-4">{error}</p>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Kolom Kiri */}
                <div>
                  <h3 className="font-semibold text-lg mb-4 border-b border-white/10 pb-2 text-white/80">Info Akun</h3>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-white/80 mb-1">Nama Lengkap</label>
                    <input type="text" name="full_name" value={currentUser?.full_name || ''} onChange={handleInputChange} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" required />
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-white/80 mb-1">Username</label>
                    <input type="text" name="username" value={currentUser?.username || ''} onChange={handleInputChange} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" required />
                  </div>
                  {!isEditing && (
                     <div className="mb-4">
                        <label className="block text-sm font-medium text-white/80 mb-1">Email</label>
                        <input type="email" name="email" value={currentUser?.email || ''} onChange={handleInputChange} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" required={!isEditing} disabled={isEditing} />
                    </div>
                  )}
                  {/* Password field */}
                  {isEditing ? (
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-white/80 mb-1">Password</label>
                      {!showPasswordField ? (
                        <div>
                          <button type="button" onClick={()=>{ setShowPasswordField(true); setPassword(''); }} className="px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white/80 hover:text-white">Edit Password</button>
                          <div className="text-xs text-white/40 mt-1">Klik untuk mengubah password karyawan ini.</div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input type="password" name="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white placeholder:text-white/40" placeholder="Masukkan password baru" />
                          <button type="button" onClick={()=>{ setShowPasswordField(false); setPassword(''); }} className="px-3 py-2 rounded-xl border border-white/10 text-white/80 hover:bg-white/5">Batal</button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-white/80 mb-1">Password</label>
                      <input type="password" name="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white placeholder:text-white/40" placeholder="" required />
                    </div>
                  )}
                   <div className="mb-4">
                    <label className="block text-sm font-medium text-white/80 mb-1">Peran</label>
                    <select
                      name="role"
                      value={(currentUser?.role === 'admin') ? 'admin' : 'karyawan'}
                      onChange={handleInputChange}
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white"
                    >
                      <option value="karyawan">Karyawan</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>
                {/* Kolom Kanan */}
                <div>
                  <h3 className="font-semibold text-lg mb-4 border-b border-white/10 pb-2 text-white/80">Info TikTok</h3>
                  <div className="mb-1 flex flex-wrap gap-2">
                    {tikTags.map((t,idx)=> (
                      <span key={`${t}-${idx}`} className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-white/15 bg-white/10 text-white/90 text-xs">
                        @{t}
                        <button type="button" onClick={()=> setTikTags(tikTags.filter((x,i)=>i!==idx))} className="text-white/70 hover:text-white">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="mb-4 flex items-center gap-2">
                    <input
                      type="text"
                      value={tikInput}
                      onChange={(e)=> setTikInput(e.target.value)}
                      onKeyDown={(e)=>{
                        if (e.key==='Enter' || e.key===',') {
                          e.preventDefault();
                          const val = tikInput.trim().replace(/^@/, '').toLowerCase();
                          if (val) setTikTags(prev=> Array.from(new Set([...prev, val])));
                          setTikInput('');
                        }
                      }}
                      placeholder="Ketik username lalu Enter"
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white"
                    />
                  </div>
                  <div className="text-xs text-white/50 mb-4">Tekan Enter untuk menambah. Yang pertama dianggap utama.</div>

                  <h3 className="font-semibold text-lg mb-2 border-b border-white/10 pb-2 text-white/80 mt-2">Info Instagram</h3>
                  <div className="mb-1 flex flex-wrap gap-2">
                    {igTags.map((t,idx)=> (
                      <span key={`${t}-${idx}`} className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-white/15 bg-white/10 text-white/90 text-xs">
                        @{t}
                        <button type="button" onClick={()=> setIgTags(igTags.filter((x,i)=>i!==idx))} className="text-white/70 hover:text-white">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="mb-4 flex items-center gap-2">
                    <input
                      type="text"
                      value={igInput}
                      onChange={(e)=> setIgInput(e.target.value)}
                      onKeyDown={(e)=>{
                        if (e.key==='Enter' || e.key===',') {
                          e.preventDefault();
                          const val = igInput.trim().replace(/^@/, '').toLowerCase();
                          if (val) setIgTags(prev=> Array.from(new Set([...prev, val])));
                          setIgInput('');
                        }
                      }}
                      placeholder="Ketik username IG lalu Enter"
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white"
                    />
                  </div>
                  <div className="text-xs text-white/50">Tekan Enter untuk menambah. Yang pertama dianggap utama.</div>
                </div>
              </div>
              <div className="mt-8 flex justify-end gap-3">
                <button type="button" onClick={closeModal} className="px-4 py-2 rounded-xl border border-white/10 text-white/80 hover:bg-white/5">Batal</button>
                <button type="submit" className="inline-flex items-center gap-2 rounded-xl px-4 py-2 bg-gradient-to-r from-blue-600 to-sky-500 text-white shadow-lg shadow-blue-600/20">{isEditing ? 'Simpan Perubahan' : 'Buat Karyawan'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
