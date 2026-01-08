'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { format, parseISO } from 'date-fns';
import { id as localeID } from 'date-fns/locale';
import TopViralDashboard from '@/components/TopViralDashboard';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

export default function DashboardTotalPage() {
  const [interval, setIntervalVal] = useState<'daily'|'weekly'|'monthly'>('daily');
  const [metric, setMetric] = useState<'views'|'likes'|'comments'>('views');
  const [start, setStart] = useState<string>(()=>{ const d=new Date(); const s=new Date(); s.setDate(d.getDate()-30); return s.toISOString().slice(0,10)});
  const [end, setEnd] = useState<string>(()=> new Date().toISOString().slice(0,10));
  const [mode, setMode] = useState<'postdate'|'accrual'>('accrual');
  const [accrualWindow, setAccrualWindow] = useState<7|28|60>(7);
  const [useCustomAccrualDates, setUseCustomAccrualDates] = useState<boolean>(false);
  const [accrualCustomStart, setAccrualCustomStart] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [accrualCustomEnd, setAccrualCustomEnd] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [weeklyView, setWeeklyView] = useState<boolean>(false);
  const [platformFilter, setPlatformFilter] = useState<'all'|'tiktok'|'instagram'>('all');
  const [showHistorical, setShowHistorical] = useState<boolean>(false);
  const [historicalData, setHistoricalData] = useState<any[]>([]);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [activeCampaignName, setActiveCampaignName] = useState<string | null>(null);
  const accrualCutoff = (process.env.NEXT_PUBLIC_ACCRUAL_CUTOFF_DATE as string) || '2025-12-20';

  const palette = ['#3b82f6','#ef4444','#22c55e','#eab308','#8b5cf6','#06b6d4','#f97316','#f43f5e','#10b981'];

  const load = async () => {
    setLoading(true);
    try {
      // effective window for accrual presets or custom dates
      const todayStr = new Date().toISOString().slice(0,10);
      const accStart = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(accrualWindow-1)); return d.toISOString().slice(0,10) })();
      const effStart = mode==='accrual' ? (useCustomAccrualDates ? accrualCustomStart : accStart) : start;
      const effEnd = mode==='accrual' ? (useCustomAccrualDates ? accrualCustomEnd : todayStr) : end;

      let json:any = null;
      if (mode === 'accrual') {
        // Parity with /groups: gunakan API accrual per-campaign, lalu gabungkan
        const campaignsRes = await fetch('/api/campaigns', { cache: 'no-store' });
        const campaigns = await campaignsRes.json();
        const groups:any[] = [];
        const sumByDate = (arrs: any[][]) => {
          const map = new Map<string, {date:string;views:number;likes:number;comments:number;shares:number;saves:number}>();
          for (const a of arrs) {
            for (const s of a||[]) {
              const k = String(s.date);
              const cur = map.get(k) || { date:k, views:0, likes:0, comments:0, shares:0, saves:0 };
              cur.views += Number(s.views)||0; cur.likes += Number(s.likes)||0; cur.comments += Number(s.comments)||0; cur.shares += Number(s.shares)||0; cur.saves += Number(s.saves)||0;
              map.set(k, cur);
            }
          }
          return Array.from(map.values()).sort((a,b)=> a.date.localeCompare(b.date));
        };
        
        // Build API URLs with custom date support
        const buildAccrualUrl = (campaignId: string) => {
          if (useCustomAccrualDates) {
            const start = new Date(accrualCustomStart);
            const end = new Date(accrualCustomEnd);
            const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
            return `/api/campaigns/${encodeURIComponent(campaignId)}/accrual?days=${days}&snapshots_only=1&cutoff=${encodeURIComponent(accrualCustomStart)}&custom=1`;
          } else {
            return `/api/campaigns/${encodeURIComponent(campaignId)}/accrual?days=${accrualWindow}&snapshots_only=1&cutoff=${encodeURIComponent(accrualCutoff)}`;
          }
        };
        
        const resps = await Promise.all((campaigns||[]).map((c:any)=> fetch(buildAccrualUrl(c.id), { cache: 'no-store' })));        
        const accs = await Promise.all(resps.map(r=> r.ok ? r.json() : Promise.resolve(null)));
        const ttAll: any[][] = []; const igAll: any[][] = []; const totalAll: any[][] = [];
        accs.forEach((acc:any, idx:number)=>{
          if (!acc) return;
          const gid = campaigns[idx]?.id;
          const gname = campaigns[idx]?.name || gid;
          groups.push({ id: gid, name: gname, series: acc?.series_total||[], series_tiktok: acc?.series_tiktok||[], series_instagram: acc?.series_instagram||[] });
          ttAll.push(acc?.series_tiktok||[]); igAll.push(acc?.series_instagram||[]); totalAll.push(acc?.series_total||[]);
        });
        const total = sumByDate(totalAll);
        const total_tiktok = sumByDate(ttAll);
        const total_instagram = sumByDate(igAll);
        json = { interval:'daily', start: effStart, end: effEnd, groups, total, total_tiktok, total_instagram };
      } else {
        // Post date: gunakan endpoint groups/series bawaan
        const url = new URL('/api/groups/series', window.location.origin);
        url.searchParams.set('start', effStart);
        url.searchParams.set('end', effEnd);
        url.searchParams.set('interval', interval);
        url.searchParams.set('mode', mode);
        url.searchParams.set('cutoff', accrualCutoff);
        const res = await fetch(url.toString(), { cache: 'no-store' });
        json = await res.json();
      }
      // Ensure platform arrays exist (older API responses might miss them)
      try {
        if (Array.isArray(json?.groups)) {
          // Derive platform totals if missing or empty
          const needTT = !Array.isArray(json?.total_tiktok) || json.total_tiktok.length === 0;
          const needIG = !Array.isArray(json?.total_instagram) || json.total_instagram.length === 0;
          if (needTT || needIG) {
            const sumByDate = (arrs: any[][], pick: (s:any)=>{views:number;likes:number;comments:number;shares?:number;saves?:number}) => {
              const map = new Map<string, any>();
              for (const g of arrs) {
                for (const s of g||[]) {
                  const k = String(s.date);
                  const v = pick(s);
                  const cur = map.get(k) || { date: k, views:0, likes:0, comments:0, shares:0, saves:0 };
                  cur.views += Number(v.views)||0; cur.likes += Number(v.likes)||0; cur.comments += Number(v.comments)||0;
                  if (typeof v.shares === 'number') cur.shares += Number(v.shares)||0;
                  if (typeof v.saves === 'number') cur.saves += Number(v.saves)||0;
                  map.set(k, cur);
                }
              }
              return Array.from(map.values()).sort((a,b)=> a.date.localeCompare(b.date));
            };
            if (needTT) {
              const ttArrays = json.groups.map((g:any)=> g.series_tiktok || []);
              json.total_tiktok = sumByDate(ttArrays, (s:any)=>({views:s.views||0, likes:s.likes||0, comments:s.comments||0, shares:s.shares||0, saves:s.saves||0}));
            }
            if (needIG) {
              const igArrays = json.groups.map((g:any)=> g.series_instagram || []);
              json.total_instagram = sumByDate(igArrays, (s:any)=>({views:s.views||0, likes:s.likes||0, comments:s.comments||0}));
            }
          }
        }
      } catch {}

      // Hide data before cutoff by zeroing values but keep dates on axis (Accrual only)
      if (mode === 'accrual') {
        const cutoffDate = useCustomAccrualDates ? accrualCustomStart : accrualCutoff;
        const zeroBefore = (arr: any[] = []) => arr.map((it:any)=>{
          if (!it || typeof it !== 'object') return it;
          if (String(it.date) < cutoffDate) {
            const r:any = { ...it };
            if ('views' in r) r.views = 0;
            if ('likes' in r) r.likes = 0;
            if ('comments' in r) r.comments = 0;
            if ('shares' in r) r.shares = 0;
            if ('saves' in r) r.saves = 0;
            return r;
          }
          return it;
        });
        if (json?.total) json.total = zeroBefore(json.total);
        if (json?.total_tiktok) json.total_tiktok = zeroBefore(json.total_tiktok);
        if (json?.total_instagram) json.total_instagram = zeroBefore(json.total_instagram);
        if (Array.isArray(json?.groups)) {
          json.groups = json.groups.map((g:any)=>({
            ...g,
            series: zeroBefore(g.series),
            series_tiktok: zeroBefore(g.series_tiktok),
            series_instagram: zeroBefore(g.series_instagram),
          }));
        }
        // Recompute header totals from masked series so header matches chart
        const sumSeries = (arr:any[] = []) => arr.reduce((a:any,s:any)=>({
          views: (a.views||0) + (Number(s.views)||0),
          likes: (a.likes||0) + (Number(s.likes)||0),
          comments: (a.comments||0) + (Number(s.comments)||0)
        }), { views:0, likes:0, comments:0 });
        json.totals = sumSeries(json.total || []);
      }
      setData(json);
    } catch {}
    setLoading(false);
  };

  useEffect(()=>{ load(); }, [start, end, interval, mode, accrualWindow, useCustomAccrualDates, accrualCustomStart, accrualCustomEnd, activeCampaignId]);
  
  // Load historical data
  useEffect(() => {
    const loadHistorical = async () => {
      if (!showHistorical) {
        console.log('[HISTORICAL] showHistorical is false, skipping load');
        setHistoricalData([]);
        return;
      }
      
      console.log('[HISTORICAL] Loading data... platformFilter:', platformFilter);
      
      try {
        // Fetch employee historical metrics (no date filter to show all historical data)
        const platformParam = platformFilter === 'all' ? '' : platformFilter;
        
        const url = `/api/admin/employee-historical?platform=${platformParam}`;
        console.log('[HISTORICAL] Fetching from:', url);
        
        const res = await fetch(url);
        const json = await res.json();
        
        console.log('[HISTORICAL] Response status:', res.status);
        console.log('[HISTORICAL] Response data:', json);
        
        if (res.ok && json.data) {
          console.log('[HISTORICAL] Data loaded successfully, count:', json.data.length);
          console.log('[HISTORICAL] Sample entry:', json.data[0]);
          // Sort by start_date to show chronologically
          const sorted = json.data.sort((a: any, b: any) => 
            new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
          );
          setHistoricalData(sorted);
        } else {
          console.error('[HISTORICAL] Failed to load:', json.error);
          setHistoricalData([]);
        }
      } catch (error) {
        console.error('[HISTORICAL] Exception:', error);
        setHistoricalData([]);
      }
    };
    
    loadHistorical();
  }, [showHistorical, platformFilter]);
  
  useEffect(()=>{
    // Fetch active campaign ID
    const fetchCampaign = async () => {
      try {
        const res = await fetch('/api/leaderboard', { cache: 'no-store' });
        const json = await res.json();
        if (res.ok && json?.campaignId) {
          setActiveCampaignId(json.campaignId);
          if (json?.campaignName) setActiveCampaignName(String(json.campaignName));
        }
      } catch {}
    };
    fetchCampaign();
    
    // reuse /api/last-updated
    const fetchLU = async () => {
      try { const r = await fetch('/api/last-updated',{cache:'no-store'}); const j=await r.json(); if (r.ok && j?.last_updated) setLastUpdated(String(j.last_updated)); } catch {}
    };
    fetchLU();
    const t = setInterval(fetchLU, 2*60*60*1000);
    return ()=> clearInterval(t);
  }, []);

  const lastUpdatedHuman = useMemo(()=>{
    if (!lastUpdated) return null; const dt=new Date(lastUpdated); const diffMin=Math.round((Date.now()-dt.getTime())/60000); if (diffMin<60) return `${diffMin} menit lalu`; const h=Math.round(diffMin/60); if (h<24) return `${h} jam lalu`; const d=Math.round(h/24); return `${d} hari lalu`;
  }, [lastUpdated]);

  const chartData = useMemo(()=>{
    if (!data) return null;
    
    // Helper: merge historical data into series
    const mergeHistoricalData = (currentData: any) => {
      console.log('[MERGE] Starting merge, showHistorical:', showHistorical);
      console.log('[MERGE] historicalData.length:', historicalData.length);
      console.log('[MERGE] currentData keys:', Object.keys(currentData || {}));
      
      if (!showHistorical || historicalData.length === 0) {
        console.log('[MERGE] Skipping merge - no historical data to add');
        return currentData;
      }
      
      console.log('[MERGE] Processing', historicalData.length, 'historical entries');
      console.log('[MERGE] Raw historical data:', historicalData);
      
      // Group by date range only (not by platform) to create proper periods
      const periodMap = new Map();
      
      historicalData.forEach((record: any) => {
        const periodKey = `${record.start_date}_${record.end_date}`;
        
        if (!periodMap.has(periodKey)) {
          periodMap.set(periodKey, {
            start_date: record.start_date,
            end_date: record.end_date,
            all: { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 },
            tiktok: { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 },
            instagram: { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 }
          });
        }
        
        const period = periodMap.get(periodKey);
        
        // Add to appropriate platform bucket
        if (record.platform === 'all') {
          period.all.views += Number(record.views) || 0;
          period.all.likes += Number(record.likes) || 0;
          period.all.comments += Number(record.comments) || 0;
          period.all.shares += Number(record.shares) || 0;
          period.all.saves += Number(record.saves) || 0;
        } else if (record.platform === 'tiktok') {
          period.tiktok.views += Number(record.views) || 0;
          period.tiktok.likes += Number(record.likes) || 0;
          period.tiktok.comments += Number(record.comments) || 0;
          period.tiktok.shares += Number(record.shares) || 0;
          period.tiktok.saves += Number(record.saves) || 0;
        } else if (record.platform === 'instagram') {
          period.instagram.views += Number(record.views) || 0;
          period.instagram.likes += Number(record.likes) || 0;
          period.instagram.comments += Number(record.comments) || 0;
          period.instagram.shares += Number(record.shares) || 0;
          period.instagram.saves += Number(record.saves) || 0;
        }
      });
      
      // Convert to series format
      const historicalSeries: any[] = [];
      
      periodMap.forEach((period) => {
        // If 'all' platform exists, use it as total, otherwise sum tiktok + instagram
        const total = period.all.views > 0 ? period.all : {
          views: period.tiktok.views + period.instagram.views,
          likes: period.tiktok.likes + period.instagram.likes,
          comments: period.tiktok.comments + period.instagram.comments,
          shares: period.tiktok.shares + period.instagram.shares,
          saves: period.tiktok.saves + period.instagram.saves
        };
        
        console.log('[MERGE] Period aggregation:', {
          dates: `${period.start_date} to ${period.end_date}`,
          has_all_platform: period.all.views > 0,
          total_views: total.views,
          tiktok_views: period.tiktok.views,
          instagram_views: period.instagram.views,
          sum_check: period.tiktok.views + period.instagram.views
        });
        
        historicalSeries.push({
          date: period.start_date,
          week_start: period.start_date,
          week_end: period.end_date,
          views: total.views,
          likes: total.likes,
          comments: total.comments,
          shares: total.shares,
          saves: total.saves,
          is_historical: true,
          platform: 'total',
          // Include platform breakdowns as objects (not just views)
          tiktok: {
            views: period.tiktok.views,
            likes: period.tiktok.likes,
            comments: period.tiktok.comments
          },
          instagram: {
            views: period.instagram.views,
            likes: period.instagram.likes,
            comments: period.instagram.comments
          }
        });
      });
      
      console.log('[MERGE] Created', historicalSeries.length, 'historical period entries');
      console.log('[MERGE] Sample historical series:', historicalSeries[0]);
      
      return {
        ...currentData,
        historical: historicalSeries
      };
    };
    
    const mergedData = mergeHistoricalData(data);
    
    // Helper: group data by week
    const groupByWeek = (series: any[], startDate: string) => {
      const start = new Date(startDate);
      const weekMap = new Map<number, { views: number; likes: number; comments: number; shares: number; saves: number; startDate: Date; endDate: Date }>();
      
      series.forEach((s: any) => {
        const date = new Date(s.date);
        const daysDiff = Math.floor((date.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        const weekNum = Math.floor(daysDiff / 7);
        
        const current = weekMap.get(weekNum) || { 
          views: 0, likes: 0, comments: 0, shares: 0, saves: 0,
          startDate: new Date(start.getTime() + weekNum * 7 * 24 * 60 * 60 * 1000),
          endDate: new Date(start.getTime() + (weekNum * 7 + 6) * 24 * 60 * 60 * 1000)
        };
        current.views += Number(s.views) || 0;
        current.likes += Number(s.likes) || 0;
        current.comments += Number(s.comments) || 0;
        current.shares += Number(s.shares) || 0;
        current.saves += Number(s.saves) || 0;
        weekMap.set(weekNum, current);
      });
      
      return Array.from(weekMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([weekNum, data]) => ({ weekNum, ...data }));
    };
    
    let labels: string[];
    let processedData: any;
    
    if (weeklyView && useCustomAccrualDates && mode === 'accrual') {
      console.log('[WEEKLY VIEW] Enabled, processing weekly data...');
      
      // Combine historical and real-time into one continuous sorted timeline
      let allPeriods: any[] = [];
      
      // Add historical periods if enabled
      if (showHistorical && mergedData.historical) {
        console.log('[WEEKLY VIEW] Adding', mergedData.historical.length, 'historical periods');
        mergedData.historical.forEach((h: any) => {
          console.log('[WEEKLY VIEW] Historical entry raw:', JSON.stringify(h));
          
          // Use week_start/week_end (from mergeHistoricalData)
          const startDate = new Date(h.week_start || h.start_date);
          const endDate = new Date(h.week_end || h.end_date);
          
          // Validate dates
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            console.warn('[WEEKLY VIEW] Invalid dates in historical entry:', h);
            return; // Skip invalid entries
          }
          
          // Extract platform data correctly
          const tiktokViews = (h.tiktok && typeof h.tiktok === 'object') ? h.tiktok.views : 0;
          const tiktokLikes = (h.tiktok && typeof h.tiktok === 'object') ? h.tiktok.likes : 0;
          const tiktokComments = (h.tiktok && typeof h.tiktok === 'object') ? h.tiktok.comments : 0;
          
          const instagramViews = (h.instagram && typeof h.instagram === 'object') ? h.instagram.views : 0;
          const instagramLikes = (h.instagram && typeof h.instagram === 'object') ? h.instagram.likes : 0;
          const instagramComments = (h.instagram && typeof h.instagram === 'object') ? h.instagram.comments : 0;
          
          const totalViews = Number(h.views) || 0;
          const totalLikes = Number(h.likes) || 0;
          const totalComments = Number(h.comments) || 0;
          
          console.log('[WEEKLY VIEW] Parsed values:', {
            period: `${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}`,
            total: { views: totalViews, likes: totalLikes, comments: totalComments },
            tiktok: { views: tiktokViews, likes: tiktokLikes, comments: tiktokComments },
            instagram: { views: instagramViews, likes: instagramLikes, comments: instagramComments }
          });
          
          allPeriods.push({
            startDate: startDate,
            endDate: endDate,
            views: totalViews,
            likes: totalLikes,
            comments: totalComments,
            tiktok: tiktokViews,
            tiktok_likes: tiktokLikes,
            tiktok_comments: tiktokComments,
            instagram: instagramViews,
            instagram_likes: instagramLikes,
            instagram_comments: instagramComments,
            is_historical: true,
            groups: [] // No groups for historical data
          });
        });
      }
      
      // Add real-time weekly data
      const startDate = accrualCustomStart;
      const weeklyTotal = groupByWeek(mergedData.total || [], startDate);
      console.log('[WEEKLY VIEW] Adding', weeklyTotal.length, 'real-time weeks');
      
      // Get platform-specific weekly data for real-time
      const weeklyTT = (Array.isArray(data.total_tiktok) && data.total_tiktok.length) 
        ? groupByWeek(data.total_tiktok, startDate) 
        : [];
      const weeklyIG = (Array.isArray(data.total_instagram) && data.total_instagram.length) 
        ? groupByWeek(data.total_instagram, startDate) 
        : [];
      
      // Get groups weekly data for real-time
      const groupsWeekly: any[] = [];
      if (data.groups && data.groups.length > 0) {
        data.groups.forEach((group: any) => {
          let groupSeries = group.series || [];
          
          // Use platform-specific series if platform filter is active
          if (platformFilter === 'tiktok' && group.series_tiktok) {
            groupSeries = group.series_tiktok;
          } else if (platformFilter === 'instagram' && group.series_instagram) {
            groupSeries = group.series_instagram;
          }
          
          if (groupSeries.length > 0) {
            const weeklyGroup = groupByWeek(groupSeries, startDate);
            groupsWeekly.push({
              name: group.name,
              weekly: weeklyGroup
            });
          }
        });
      }
      
      console.log('[WEEKLY VIEW] Groups aggregated:', groupsWeekly.length);
      
      weeklyTotal.forEach((w: any, idx: number) => {
        const ttData = weeklyTT[idx] || { views: 0, likes: 0, comments: 0 };
        const igData = weeklyIG[idx] || { views: 0, likes: 0, comments: 0 };
        
        // Collect group data for this week
        const groupsData: any[] = [];
        groupsWeekly.forEach((gw: any) => {
          if (gw.weekly[idx]) {
            groupsData.push({
              name: gw.name,
              views: gw.weekly[idx].views || 0,
              likes: gw.weekly[idx].likes || 0,
              comments: gw.weekly[idx].comments || 0
            });
          }
        });
        
        allPeriods.push({
          startDate: w.startDate,
          endDate: w.endDate,
          views: w.views,
          likes: w.likes,
          comments: w.comments,
          tiktok: ttData.views,
          tiktok_likes: ttData.likes,
          tiktok_comments: ttData.comments,
          instagram: igData.views,
          instagram_likes: igData.likes,
          instagram_comments: igData.comments,
          is_historical: false,
          groups: groupsData
        });
      });
      
      // Deduplicate: Remove duplicate periods (same start+end date)
      // Historical data takes priority over real-time if same period
      const uniquePeriods = new Map();
      
      allPeriods.forEach((p: any) => {
        const key = `${p.startDate.getTime()}_${p.endDate.getTime()}`;
        
        // If period doesn't exist, or current is historical and existing is not, use current
        if (!uniquePeriods.has(key) || (p.is_historical && !uniquePeriods.get(key).is_historical)) {
          uniquePeriods.set(key, p);
        }
      });
      
      allPeriods = Array.from(uniquePeriods.values());
      
      // Filter out completely empty periods (all metrics are 0)
      allPeriods = allPeriods.filter((p: any) => {
        // Check if period is completely empty
        const hasViews = p.views > 0 || p.likes > 0 || p.comments > 0;
        const hasPlatformData = p.tiktok > 0 || p.instagram > 0;
        const hasGroupData = p.groups && p.groups.some((g: any) => g.views > 0 || g.likes > 0 || g.comments > 0);
        
        const isEmpty = !hasViews && !hasPlatformData && !hasGroupData;
        
        if (isEmpty) {
          console.log('[FILTER] Removing empty period:', {
            dates: `${p.startDate.toISOString().slice(0,10)} to ${p.endDate.toISOString().slice(0,10)}`,
            is_historical: p.is_historical,
            reason: 'No data (all values are 0)'
          });
        }
        
        return !isEmpty; // Keep only periods with data
      });
      
      // Sort by start date for continuous timeline
      allPeriods.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
      
      console.log('[WEEKLY VIEW] After filtering empty periods, remaining:', allPeriods.length);
      
      // Generate labels from sorted periods
      labels = allPeriods.map((p: any) => {
        const start = format(p.startDate, 'd MMM', { locale: localeID });
        const end = format(p.endDate, 'd MMM', { locale: localeID });
        return `${start}-${end}`;
      });
      
      console.log('[WEEKLY VIEW] Labels:', labels);
      
      const datasets: any[] = [];
      
      // Total line values
      let totalVals = allPeriods.map((p: any) => 
        metric === 'likes' ? p.likes : metric === 'comments' ? p.comments : p.views
      );
      
      console.log('[WEEKLY VIEW] Total values for metric', metric, ':', totalVals);
      console.log('[WEEKLY VIEW] First 3 periods:', allPeriods.slice(0, 3).map(p => ({
        dates: `${p.startDate.toISOString().slice(0,10)} to ${p.endDate.toISOString().slice(0,10)}`,
        views: p.views,
        tiktok: p.tiktok,
        instagram: p.instagram,
        is_historical: p.is_historical
      })));
      
      // Style: solid line for all (no dashed distinction)
      datasets.push({ 
        label: platformFilter === 'all' ? 'Total' : platformFilter === 'tiktok' ? 'TikTok' : 'Instagram', 
        data: totalVals, 
        borderColor: palette[0], 
        backgroundColor: palette[0] + '33', 
        fill: true, 
        tension: 0.35
      });
      
      // Platform breakdown (only if 'all' is selected)
      if (platformFilter === 'all') {
        // TikTok breakdown
        const tiktokVals = allPeriods.map((p: any) => {
          const val = metric === 'likes' ? p.tiktok_likes : metric === 'comments' ? p.tiktok_comments : p.tiktok;
          return val || 0;
        });
        
        console.log('[WEEKLY VIEW] TikTok values:', tiktokVals.slice(0, 5));
        
        datasets.push({ 
          label: 'TikTok', 
          data: tiktokVals, 
          borderColor: '#38bdf8', 
          backgroundColor: 'rgba(56,189,248,0.15)', 
          fill: false, 
          tension: 0.35
        });
        
        // Instagram breakdown
        const instagramVals = allPeriods.map((p: any) => {
          const val = metric === 'likes' ? p.instagram_likes : metric === 'comments' ? p.instagram_comments : p.instagram;
          return val || 0;
        });
        
        console.log('[WEEKLY VIEW] Instagram values:', instagramVals.slice(0, 5));
        
        datasets.push({ 
          label: 'Instagram', 
          data: instagramVals, 
          borderColor: '#f43f5e', 
          backgroundColor: 'rgba(244,63,94,0.15)', 
          fill: false, 
          tension: 0.35
        });
      }
      
      // Per group lines - extract from allPeriods
      if (data.groups && data.groups.length > 0) {
        data.groups.forEach((group: any, idx: number) => {
          const groupVals = allPeriods.map((p: any) => {
            // Find matching group data in this period
            const groupData = p.groups && p.groups.find((g: any) => g.name === group.name);
            if (!groupData) return 0;
            
            return metric === 'likes' ? groupData.likes : metric === 'comments' ? groupData.comments : groupData.views;
          });
          
          console.log(`[WEEKLY VIEW] Group ${group.name} values:`, groupVals.slice(0, 5));
          
          datasets.push({
            label: group.name,
            data: groupVals,
            borderColor: palette[(idx + 3) % palette.length],
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.35
          });
        });
      }
      
      return { labels, datasets };
    }
    
    // Daily view (existing code)
    labels = (data.total || []).map((s:any)=>{
      const d = parseISO(s.date);
      if (interval==='monthly') return format(d,'MMM yyyy', {locale: localeID});
      return format(d,'d MMM', {locale: localeID});
    });
    const datasets:any[] = [];
    
    // Total first (filtered by platform)
    let totalSeries = data.total || [];
    if (platformFilter === 'tiktok' && Array.isArray(data.total_tiktok) && data.total_tiktok.length) {
      totalSeries = data.total_tiktok;
    } else if (platformFilter === 'instagram' && Array.isArray(data.total_instagram) && data.total_instagram.length) {
      totalSeries = data.total_instagram;
    }
    
    const totalVals = totalSeries.map((s:any)=> metric==='likes'? s.likes : metric==='comments'? s.comments : s.views);
    datasets.push({ 
      label: platformFilter === 'all' ? 'Total' : platformFilter === 'tiktok' ? 'TikTok' : 'Instagram',
      data: totalVals, 
      borderColor: palette[0], 
      backgroundColor: palette[0]+'33', 
      fill: true, 
      tension: 0.35 
    });
    
    // Platform breakdown if available (only when 'all' selected)
    if (platformFilter === 'all') {
      if (Array.isArray(data.total_tiktok) && data.total_tiktok.length) {
        const ttVals = data.total_tiktok.map((s:any)=> metric==='likes'? s.likes : metric==='comments'? s.comments : s.views);
        datasets.push({ label:'TikTok', data: ttVals, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.15)', fill: false, tension: 0.35 });
      }
      if (Array.isArray(data.total_instagram) && data.total_instagram.length) {
        const igVals = data.total_instagram.map((s:any)=> metric==='likes'? s.likes : metric==='comments'? s.comments : s.views);
        datasets.push({ label:'Instagram', data: igVals, borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.15)', fill: false, tension: 0.35 });
      }
    }
    
    // Per group lines (filter by platform)
    for (let i=0;i<(data.groups||[]).length;i++){
      const g = data.groups[i];
      let seriesToUse = g.series || [];
      
      if (platformFilter === 'tiktok' && g.series_tiktok) {
        seriesToUse = g.series_tiktok;
      } else if (platformFilter === 'instagram' && g.series_instagram) {
        seriesToUse = g.series_instagram;
      }
      
      const map:Record<string,any> = {}; 
      seriesToUse.forEach((s:any)=>{ map[String(s.date)] = s; });
      const vals = (totalSeries).map((t:any)=>{ 
        const it = map[String(t.date)] || { views:0, likes:0, comments:0 }; 
        return metric==='likes'? it.likes : metric==='comments'? it.comments : it.views; 
      });
      const color = palette[(i+1)%palette.length];
      datasets.push({ label: g.name, data: vals, borderColor: color, backgroundColor: color+'33', fill: false, tension:0.35 });
    }
    return { labels, datasets };
  }, [data, metric, interval, weeklyView, useCustomAccrualDates, mode, accrualCustomStart, platformFilter]);

  // Crosshair + floating label, like Groups
  const chartRef = useRef<any>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const crosshairPlugin = useMemo(()=>({
    id: 'crosshairPlugin',
    afterDraw(chart:any){
      const { ctx, chartArea } = chart; if (!chartArea) return; const { top,bottom,left,right }=chartArea;
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      let idx: number | null = null; let x: number | null = null;
      if (active && active.length>0){ idx=active[0].index; x=active[0].element.x; } else {
        const labels = chart.data?.labels||[]; if (!labels.length) return; idx=labels.length-1; const meta=chart.getDatasetMeta(0); const el=meta?.data?.[idx]; x=el?.x??null; }
      if (idx==null || x==null) return;
      ctx.save(); ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.setLineDash([4,4]); ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom); ctx.stroke(); ctx.restore();
      try{
        const label = String(chart.data.labels[idx]); const totalDs = chart.data.datasets?.[0]; const v = Array.isArray(totalDs?.data)? Number(totalDs.data[idx]||0):0; const txt=`${new Intl.NumberFormat('id-ID').format(Math.round(v))}  ${label}`;
        ctx.save(); ctx.font='12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial'; const padX=8,padY=6; const tw=ctx.measureText(txt).width; const boxW=tw+padX*2, boxH=22; const bx=Math.min(right-boxW-6, Math.max(left+6, x+8)); const by=top+8; const r=6; ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.moveTo(bx+r,by); ctx.lineTo(bx+boxW-r,by); ctx.quadraticCurveTo(bx+boxW,by,bx+boxW,by+r); ctx.lineTo(bx+boxW,by+boxH-r); ctx.quadraticCurveTo(bx+boxW,by+boxH,bx+boxW-r,by+boxH); ctx.lineTo(bx+r,by+boxH); ctx.quadraticCurveTo(bx,by+boxH,bx,by+boxH-r); ctx.lineTo(bx,by+r); ctx.quadraticCurveTo(bx,by,bx+r,by); ctx.closePath(); ctx.fill(); ctx.fillStyle='#fff'; ctx.fillText(txt,bx+padX,by+boxH-padY); ctx.restore();
      } catch {}
    }
  }), []);

  return (
    <div className="min-h-screen p-4 md:p-8">
      {/* Header with totals */}
      <div className="glass rounded-2xl p-4 border border-white/10 mb-4">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/70">
          {data && (
            <>
              <span>Views: <strong className="text-white">{Number(data.totals?.views||0).toLocaleString('id-ID')}</strong></span>
              <span>Likes: <strong className="text-white">{Number(data.totals?.likes||0).toLocaleString('id-ID')}</strong></span>
              <span>Comments: <strong className="text-white">{Number(data.totals?.comments||0).toLocaleString('id-ID')}</strong></span>
              {lastUpdatedHuman && (
                <span className="ml-auto text-white/60">Terakhir diperbarui: <strong className="text-white/80">{lastUpdatedHuman}</strong></span>
              )}
            </>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          {mode === 'postdate' ? (
            <div className="flex items-center gap-2 mr-2">
              <input type="date" value={start} onChange={(e)=>setStart(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
              <span className="text-white/50">s/d</span>
              <input type="date" value={end} onChange={(e)=>setEnd(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
            </div>
          ) : (
            <div className="flex flex-col gap-2 items-end">
              <label className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useCustomAccrualDates}
                  onChange={(e) => setUseCustomAccrualDates(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-blue-600"
                />
                <span>Custom Date</span>
              </label>
              {useCustomAccrualDates && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <input type="date" value={accrualCustomStart} onChange={(e)=>setAccrualCustomStart(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
                    <span className="text-white/50">→</span>
                    <input type="date" value={accrualCustomEnd} onChange={(e)=>setAccrualCustomEnd(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={weeklyView}
                      onChange={(e) => setWeeklyView(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-blue-600"
                    />
                    <span>Tampilan Mingguan</span>
                  </label>
                  {weeklyView && (
                    <label className="flex items-center gap-2 text-xs text-white/70 cursor-pointer ml-4">
                      <input
                        type="checkbox"
                        checked={showHistorical}
                        onChange={(e) => setShowHistorical(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-blue-600"
                      />
                      <span>Tampilkan Data Historis</span>
                    </label>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Controls: move Mode to the left, Interval to the center, Metric to the right */}
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 items-center gap-2 text-xs">
        {/* Left: Mode (+ accrual window when applicable) */}
        <div className="flex items-center gap-2 justify-start">
          <span className="text-white/60">Mode:</span>
          <button className={`px-2 py-1 rounded ${mode==='accrual'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMode('accrual')}>Accrual</button>
          <button className={`px-2 py-1 rounded ${mode==='postdate'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMode('postdate')}>Post Date</button>
          {mode==='accrual' && !useCustomAccrualDates && (
            <div className="flex items-center gap-2 ml-2">
              <span className="text-white/60">Rentang:</span>
              <button className={`px-2 py-1 rounded ${accrualWindow===7?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(7)}>7 hari</button>
              <button className={`px-2 py-1 rounded ${accrualWindow===28?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(28)}>28 hari</button>
              <button className={`px-2 py-1 rounded ${accrualWindow===60?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(60)}>60 hari</button>
            </div>
          )}
        </div>

        {/* Center: Interval */}
        <div className="flex items-center gap-2 justify-center">
          {mode!=='accrual' && (
            <>
              <span className="text-white/60">Interval:</span>
              <button className={`px-2 py-1 rounded ${interval==='daily'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('daily')}>Harian</button>
              <button className={`px-2 py-1 rounded ${interval==='weekly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('weekly')}>Mingguan</button>
              <button className={`px-2 py-1 rounded ${interval==='monthly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('monthly')}>Bulanan</button>
            </>
          )}
        </div>

        {/* Right: Metric */}
        <div className="flex items-center gap-2 justify-end">
          <span className="text-white/60">Metric:</span>
          <button className={`px-2 py-1 rounded ${metric==='views'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('views')}>Views</button>
          <button className={`px-2 py-1 rounded ${metric==='likes'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('likes')}>Likes</button>
          <button className={`px-2 py-1 rounded ${metric==='comments'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('comments')}>Comments</button>
        </div>
      </div>
      
      {/* Platform Filter */}
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="text-white/60">Platform:</span>
        <button className={`px-2 py-1 rounded ${platformFilter==='all'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setPlatformFilter('all')}>Semua</button>
        <button className={`px-2 py-1 rounded flex items-center gap-1 ${platformFilter==='tiktok'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setPlatformFilter('tiktok')}>
          <span className="text-[#38bdf8]">●</span> TikTok
        </button>
        <button className={`px-2 py-1 rounded flex items-center gap-1 ${platformFilter==='instagram'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setPlatformFilter('instagram')}>
          <span className="text-[#f43f5e]">●</span> Instagram
        </button>
      </div>

      <div className="glass rounded-2xl p-4 md:p-6 border border-white/10 overflow-x-auto">
        {loading && <p className="text-white/60">Memuat…</p>}
        {!loading && chartData && (
          <Line ref={chartRef} data={chartData} plugins={[crosshairPlugin]} options={{
            responsive:true,
            interaction:{ mode:'index', intersect:false },
            plugins:{ 
              legend:{ labels:{ color:'rgba(255,255,255,0.8)'} },
              tooltip: {
                filter: function(tooltipItem: any) {
                  // Hide group lines if value is 0 (historical data doesn't have groups)
                  const label = tooltipItem.dataset.label || '';
                  const value = tooltipItem.parsed.y;
                  
                  // If it's a group (Group A, B, C, D) and value is 0, hide it
                  if (label.startsWith('Group') && value === 0) {
                    return false;
                  }
                  
                  return true;
                }
              }
            },
            scales:{
              x:{
                ticks:{ color:'rgba(255,255,255,0.6)', autoSkip: interval !== 'daily', maxRotation:0, minRotation:0 },
                grid:{ color:'rgba(255,255,255,0.06)'}
              },
              y:{ ticks:{ color:'rgba(255,255,255,0.6)'}, grid:{ color:'rgba(255,255,255,0.06)'} }
            },
            onHover: (_e:any, el:any[])=> setActiveIndex(el && el.length>0 ? (el[0].index ?? null) : null)
          }} onMouseLeave={()=> setActiveIndex(null)} />
        )}
      </div>

      {/* Top 5 Video FYP Section (aggregate across all groups when campaignId undefined) */}
      <div className="mt-8">
        <TopViralDashboard 
          days={accrualWindow === 7 ? 7 : 28} 
          limit={5} 
        />
      </div>
    </div>
  );
}
