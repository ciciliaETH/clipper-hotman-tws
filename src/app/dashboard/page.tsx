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
  // Set default start date to 13 January 2026
  const [start, setStart] = useState<string>('2026-01-13');
  const [end, setEnd] = useState<string>(()=> new Date().toISOString().slice(0,10));
  const [mode, setMode] = useState<'postdate'|'accrual'>('postdate');
  const [accrualWindow, setAccrualWindow] = useState<7|28|60>(7);
  const [useCustomAccrualDates, setUseCustomAccrualDates] = useState<boolean>(true); // Changed to true
  const [accrualCustomStart, setAccrualCustomStart] = useState<string>(() => {
    // Default to start of August 2025 to show historical data
    return '2025-08-02';
  });
  const [accrualCustomEnd, setAccrualCustomEnd] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [weeklyView, setWeeklyView] = useState<boolean>(true); // Changed to true
  const [platformFilter, setPlatformFilter] = useState<'all'|'tiktok'|'instagram'>('all');
  const [showHistorical, setShowHistorical] = useState<boolean>(false);
  const [showPosts, setShowPosts] = useState<boolean>(true); // Show posts line on chart
  const [historicalData, setHistoricalData] = useState<any[]>([]);
  const [postsData, setPostsData] = useState<any[]>([]); // Posts per day/period

  // Calculate total posts from postsData (sum all 'posts' property from API)
  const totalPosts = useMemo(() => {
    if (!Array.isArray(postsData)) return 0;
    return postsData.reduce((sum, p) => sum + (p.posts ?? 0), 0);
  }, [postsData]);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [activeCampaignName, setActiveCampaignName] = useState<string | null>(null);
  const accrualCutoff = (process.env.NEXT_PUBLIC_ACCRUAL_CUTOFF_DATE as string) || '2026-01-02';

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
        // Accrual now uses employee-based series endpoint (no campaigns)
        const url = new URL('/api/groups/series', window.location.origin);
        url.searchParams.set('start', effStart);
        url.searchParams.set('end', effEnd);
        url.searchParams.set('interval', 'daily');
        url.searchParams.set('mode', 'accrual');
        // Allow augmentation from posts_daily when snapshots are missing
        url.searchParams.set('snapshots_only', '0');
        url.searchParams.set('cutoff', accrualCutoff);
        const res = await fetch(url.toString(), { cache: 'no-store' });
        json = await res.json();
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
        const cutoffDate = accrualCutoff; // hanya realtime yang di-mask oleh cutoff global
        const zeroBefore = (arr: any[] = []) => arr.map((it:any)=>{
          if (!it || typeof it !== 'object') return it;
          if (String(it.date) <= cutoffDate) {
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
  // Historical disabled: ensure empty
  useEffect(() => { setHistoricalData([]); }, [showHistorical, platformFilter]);
  
  // Load posts data for chart
  useEffect(() => {
    const loadPosts = async () => {
      if (!showPosts) {
        setPostsData([]);
        return;
      }
      
      try {
        const todayStr = new Date().toISOString().slice(0, 10);
        const effStart = mode === 'accrual' ? (useCustomAccrualDates ? accrualCustomStart : (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - (accrualWindow - 1)); return d.toISOString().slice(0, 10); })()) : start;
        const effEnd = mode === 'accrual' ? (useCustomAccrualDates ? accrualCustomEnd : todayStr) : end;
        
        const url = new URL('/api/posts-series', window.location.origin);
        url.searchParams.set('start', effStart);
        url.searchParams.set('end', effEnd);
        url.searchParams.set('platform', platformFilter);
        
        const res = await fetch(url.toString(), { cache: 'no-store' });
        const json = await res.json();
        
        if (res.ok && json.series) {
          setPostsData(json.series);
        } else {
          setPostsData([]);
        }
      } catch {
        setPostsData([]);
      }
    };
    
    loadPosts();
  }, [showPosts, mode, accrualWindow, useCustomAccrualDates, accrualCustomStart, accrualCustomEnd, start, end, platformFilter]);
  
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
      
      if (true || !showHistorical || historicalData.length === 0) {
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
      // Parse dates consistently as UTC to avoid timezone issues
      const start = new Date(startDate + 'T00:00:00Z');
      const weekMap = new Map<number, { views: number; likes: number; comments: number; shares: number; saves: number; startDate: Date; endDate: Date }>();
      
      series.forEach((s: any) => {
        // Parse series date as UTC
        const dateStr = String(s.date).slice(0, 10);
        const date = new Date(dateStr + 'T00:00:00Z');
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
      
      // Combine periods (historical + real-time)
      // We'll build real-time weeks first, then merge historical periods into the
      // closest overlapping real-time week to avoid double counting or bucket drift
      let allPeriods: any[] = [];
      const histPeriods: any[] = [];
      // Active date range boundaries for filtering (UTC)
      const rangeStart = new Date(accrualCustomStart + 'T00:00:00Z');
      const rangeEnd = new Date(accrualCustomEnd + 'T23:59:59Z');
      
      // Historical periods (trim to selected range; they will be added to real-time by aggregation below)
      if (false && showHistorical && mergedData.historical) {
        console.log('[WEEKLY VIEW] Adding', mergedData.historical.length, 'historical periods');
        mergedData.historical.forEach((h: any) => {
          console.log('[WEEKLY VIEW] Historical entry raw:', JSON.stringify(h));
          
          // Use week_start/week_end (from mergeHistoricalData), parse as UTC
          const startStr = String(h.week_start || h.start_date).slice(0, 10);
          const endStr = String(h.week_end || h.end_date).slice(0, 10);
          const startDate = new Date(startStr + 'T00:00:00Z');
          const endDate = new Date(endStr + 'T23:59:59Z');
          
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
          
          histPeriods.push({
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
      
      // Historical cutoff for weekly view
      const HISTORICAL_CUTOFF = '2026-01-02';
      const REALTIME_START = '2026-01-03';
      
      console.log('[WEEKLY VIEW] ═══════════════════════════════════════════════════════════');
      console.log('[WEEKLY VIEW] Range:', accrualCustomStart, 'to', accrualCustomEnd);
      console.log('[WEEKLY VIEW] Historical cutoff:', HISTORICAL_CUTOFF);
      console.log('[WEEKLY VIEW] Historical periods loaded:', histPeriods.length);
      console.log('[WEEKLY VIEW] Real-time daily entries:', (data.total || []).length);
      
      // Step 1: Add historical periods directly (they are already weekly)
      // Only add periods that overlap with selected range
      histPeriods.forEach((hp: any) => {
        const hpStart = hp.startDate.toISOString().slice(0,10);
        const hpEnd = hp.endDate.toISOString().slice(0,10);
        
        // Check if period overlaps with selected range
        if (hpEnd >= accrualCustomStart && hpStart <= accrualCustomEnd) {
          console.log(`[WEEKLY VIEW] Adding historical period: ${hpStart} to ${hpEnd} = ${hp.views.toLocaleString()} views`);
          allPeriods.push({
            ...hp,
            is_historical: true
          });
        } else {
          console.log(`[WEEKLY VIEW] Skip historical (out of range): ${hpStart} to ${hpEnd}`);
        }
      });
      
      // Step 2: Add real-time weekly data (only for dates >= REALTIME_START)
      // Filter real-time data to only include dates after historical cutoff
      const realtimeData = (data.total || []).filter((d: any) => String(d.date) >= REALTIME_START);
      const realtimeTT = (data.total_tiktok || []).filter((d: any) => String(d.date) >= REALTIME_START);
      const realtimeIG = (data.total_instagram || []).filter((d: any) => String(d.date) >= REALTIME_START);
      
      console.log('[WEEKLY VIEW] Real-time entries after cutoff:', realtimeData.length);
      
      if (realtimeData.length > 0) {
        // Group real-time data by week starting from REALTIME_START
        const weeklyTotal = groupByWeek(realtimeData, REALTIME_START);
        const weeklyTT = groupByWeek(realtimeTT, REALTIME_START);
        const weeklyIG = groupByWeek(realtimeIG, REALTIME_START);
        
        console.log('[WEEKLY VIEW] Real-time weeks:', weeklyTotal.length);
        
        // Build maps for platform data
        const ttByWeekNum = new Map<number, any>();
        weeklyTT.forEach((w: any) => ttByWeekNum.set(w.weekNum, w));
        const igByWeekNum = new Map<number, any>();
        weeklyIG.forEach((w: any) => igByWeekNum.set(w.weekNum, w));
        
        // Get groups weekly data for real-time
        const groupsWeekly: any[] = [];
        if (data.groups && data.groups.length > 0) {
          data.groups.forEach((group: any) => {
            let groupSeries = (group.series || []).filter((d: any) => String(d.date) >= REALTIME_START);
            
            if (platformFilter === 'tiktok' && group.series_tiktok) {
              groupSeries = (group.series_tiktok || []).filter((d: any) => String(d.date) >= REALTIME_START);
            } else if (platformFilter === 'instagram' && group.series_instagram) {
              groupSeries = (group.series_instagram || []).filter((d: any) => String(d.date) >= REALTIME_START);
            }
            
            if (groupSeries.length > 0) {
              const weeklyGroup = groupByWeek(groupSeries, REALTIME_START);
              groupsWeekly.push({ name: group.name, weekly: weeklyGroup });
            }
          });
        }
        
        // Build maps for groups by weekNum
        const groupsByWeekNum = new Map<number, any[]>();
        groupsWeekly.forEach((gw: any) => {
          gw.weekly.forEach((wk: any) => {
            const arr = groupsByWeekNum.get(wk.weekNum) || [];
            arr.push({ name: gw.name, views: wk.views || 0, likes: wk.likes || 0, comments: wk.comments || 0 });
            groupsByWeekNum.set(wk.weekNum, arr);
          });
        });
        
        // Add real-time weekly periods
        weeklyTotal.forEach((w: any) => {
          const ttData = ttByWeekNum.get(w.weekNum) || { views: 0, likes: 0, comments: 0 };
          const igData = igByWeekNum.get(w.weekNum) || { views: 0, likes: 0, comments: 0 };
          const groupsData = groupsByWeekNum.get(w.weekNum) || [];
          
          // Only add if overlaps with selected range
          const wStart = w.startDate.toISOString().slice(0,10);
          const wEnd = w.endDate.toISOString().slice(0,10);
          
          if (wEnd >= accrualCustomStart && wStart <= accrualCustomEnd) {
            console.log(`[WEEKLY VIEW] Adding real-time week: ${wStart} to ${wEnd} = ${w.views.toLocaleString()} views`);
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
          }
        });
      }
      
      console.log('[WEEKLY VIEW] Total periods before sort:', allPeriods.length);

      // Sort by start date for continuous timeline
      allPeriods.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

      // Aggregate by identical period (start/end): merge any duplicates
      const agg = new Map<string, any>();
      for (const p of allPeriods) {
        const startKey = p.startDate.toISOString().slice(0, 10);
        const endKey = p.endDate.toISOString().slice(0, 10);
        const key = `${startKey}_${endKey}`;
        const cur = agg.get(key) || {
          startDate: new Date(startKey + 'T00:00:00Z'),
          endDate: new Date(endKey + 'T00:00:00Z'),
          views: 0, likes: 0, comments: 0,
          tiktok: 0, tiktok_likes: 0, tiktok_comments: 0,
          instagram: 0, instagram_likes: 0, instagram_comments: 0,
          is_historical: p.is_historical,
          groups: [] as any[],
        };
        cur.views += Number(p.views)||0;
        cur.likes += Number(p.likes)||0;
        cur.comments += Number(p.comments)||0;
        cur.tiktok += Number(p.tiktok)||0;
        cur.tiktok_likes += Number(p.tiktok_likes)||0;
        cur.tiktok_comments += Number(p.tiktok_comments)||0;
        cur.instagram += Number(p.instagram)||0;
        cur.instagram_likes += Number(p.instagram_likes)||0;
        cur.instagram_comments += Number(p.instagram_comments)||0;
        if (Array.isArray(p.groups) && p.groups.length) {
          const map = new Map<string, any>(cur.groups.map((g:any)=>[g.name, g] as const));
          for (const g of p.groups) {
            const ex = map.get(g.name) || { name:g.name, views:0, likes:0, comments:0 };
            ex.views += Number(g.views)||0; ex.likes += Number(g.likes)||0; ex.comments += Number(g.comments)||0;
            map.set(g.name, ex);
          }
          cur.groups = Array.from(map.values());
        }
        agg.set(key, cur);
      }
      allPeriods = Array.from(agg.values());
      allPeriods.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
      
      console.log('[WEEKLY VIEW] FINAL periods:', allPeriods.length);
      allPeriods.forEach((p, idx) => {
        const marker = p.is_historical ? '📊 HIST' : '🔴 RT';
        console.log(`  ${marker} [${idx}]: ${p.startDate.toISOString().slice(0,10)} to ${p.endDate.toISOString().slice(0,10)} = ${p.views.toLocaleString()} views`);
      });
      
      // ═══════════════════════════════════════════════════════════════════
      // Keep empty periods so timeline stays complete and consistent
      
      // Sort by start date for continuous timeline
      allPeriods.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
      
      console.log('[WEEKLY VIEW] FINAL periods after aggregation:', allPeriods.length);
      allPeriods.forEach((p, idx) => {
        console.log(`  FINAL[${idx}]: ${p.startDate.toISOString().slice(0,10)} to ${p.endDate.toISOString().slice(0,10)} = ${p.views.toLocaleString()} views`);
      });
      
      // ═══════════════════════════════════════════════════════════════════
      // AUDIT: Log all periods with detailed breakdown
      // ═══════════════════════════════════════════════════════════════════
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('[AUDIT] CHART PERIODS BREAKDOWN');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      let runningViews = 0;
      let historicalCount = 0;
      let realtimeCount = 0;
      
      const auditTable = allPeriods.map((p: any, idx: number) => {
        const start = p.startDate.toISOString().slice(0, 10);
        const end = p.endDate.toISOString().slice(0, 10);
        const views = Number(p.views) || 0;
        const tiktok = Number(p.tiktok) || 0;
        const instagram = Number(p.instagram) || 0;
        
        runningViews += views;
        
        if (p.is_historical) {
          historicalCount++;
        } else {
          realtimeCount++;
        }
        
        return {
          '#': idx + 1,
          'Start': start,
          'End': end,
          'Type': p.is_historical ? '📊 Historical' : '🔴 Real-time',
          'Views': views.toLocaleString('id-ID'),
          'TikTok': tiktok.toLocaleString('id-ID'),
          'Instagram': instagram.toLocaleString('id-ID'),
          'Running Total': runningViews.toLocaleString('id-ID')
        };
      });
      
      console.table(auditTable);
      
      console.log('');
      console.log('[AUDIT] SUMMARY:');
      console.log('  Total periods:', allPeriods.length);
      console.log('  Historical:', historicalCount);
      console.log('  Real-time:', realtimeCount);
      console.log('  ─────────────────────────────────────────');
      console.log('  TOTAL VIEWS (from chart):', runningViews.toLocaleString('id-ID'));
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
      
      // Generate labels from sorted periods (shorter format to avoid overlap)
      labels = allPeriods.map((p: any) => {
        const start = format(p.startDate, 'd', { locale: localeID });
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
        tension: 0.35,
        yAxisID: 'y'
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
          tension: 0.35,
          yAxisID: 'y'
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
          tension: 0.35,
          yAxisID: 'y'
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
            tension: 0.35,
            yAxisID: 'y'
          });
        });
      }
      
      // Posts line (if showPosts is enabled)
      if (showPosts && postsData.length > 0) {
        // Group posts by week matching allPeriods
        const postsMap = new Map<string, number>();
        postsData.forEach((p: any) => {
          postsMap.set(p.date, p.posts || 0);
        });
        
        const postsVals = allPeriods.map((period: any) => {
          // Sum posts within this period's date range
          const startDate = period.startDate;
          const endDate = period.endDate;
          let sum = 0;
          
          for (const [dateStr, count] of postsMap.entries()) {
            const d = new Date(dateStr + 'T00:00:00Z');
            if (d >= startDate && d <= endDate) {
              sum += count;
            }
          }
          return sum;
        });
        
        datasets.push({
          label: 'Posts',
          data: postsVals,
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.15)',
          fill: false,
          tension: 0.35,
          yAxisID: 'y1',
          borderDash: [5, 5]
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
      tension: 0.35,
      yAxisID: 'y'
    });
    
    // Platform breakdown if available (only when 'all' selected)
    if (platformFilter === 'all') {
      if (Array.isArray(data.total_tiktok) && data.total_tiktok.length) {
        const ttVals = data.total_tiktok.map((s:any)=> metric==='likes'? s.likes : metric==='comments'? s.comments : s.views);
        datasets.push({ label:'TikTok', data: ttVals, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.15)', fill: false, tension: 0.35, yAxisID: 'y' });
      }
      if (Array.isArray(data.total_instagram) && data.total_instagram.length) {
        const igVals = data.total_instagram.map((s:any)=> metric==='likes'? s.likes : metric==='comments'? s.comments : s.views);
        datasets.push({ label:'Instagram', data: igVals, borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.15)', fill: false, tension: 0.35, yAxisID: 'y' });
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
      datasets.push({ label: g.name, data: vals, borderColor: color, backgroundColor: color+'33', fill: false, tension:0.35, yAxisID: 'y' });
    }
    
    // Posts line (if showPosts is enabled) - Daily view
    if (showPosts && postsData.length > 0) {
      const postsMap = new Map<string, number>();
      postsData.forEach((p: any) => {
        postsMap.set(p.date, p.posts || 0);
      });
      
      const postsVals = totalSeries.map((t: any) => postsMap.get(String(t.date)) || 0);
      
      datasets.push({
        label: 'Posts',
        data: postsVals,
        borderColor: '#a855f7',
        backgroundColor: 'rgba(168, 85, 247, 0.15)',
        fill: false,
        tension: 0.35,
        yAxisID: 'y1',
        borderDash: [5, 5]
      });
    }
    
    return { labels, datasets };
  }, [data, metric, interval, weeklyView, useCustomAccrualDates, mode, accrualCustomStart, platformFilter, showPosts, postsData]);

  // Crosshair + floating label, like Groups
  const chartRef = useRef<any>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  
  // Calculate grand totals strictly from current masked server totals
  const grandTotals = useMemo(() => {
    if (!data) return { views: 0, likes: 0, comments: 0 };
    // Base = sum from currently selected platform series so header matches chart
    const sumArr = (arr:any[] = []) => arr.reduce((a:any,s:any)=>({
      views: (a.views||0) + Number(s.views||0),
      likes: (a.likes||0) + Number(s.likes||0),
      comments: (a.comments||0) + Number(s.comments||0)
    }), { views:0, likes:0, comments:0 });
    let base = { views:0, likes:0, comments:0 } as any;
    if (platformFilter === 'tiktok' && Array.isArray(data.total_tiktok)) {
      base = sumArr(data.total_tiktok);
    } else if (platformFilter === 'instagram' && Array.isArray(data.total_instagram)) {
      base = sumArr(data.total_instagram);
    } else {
      base = sumArr(data.total || []);
    }
    // Tambahkan historical hanya pada mode accrual + weekly + custom dates
    if (weeklyView && mode==='accrual' && useCustomAccrualDates && showHistorical && historicalData.length) {
      // Use UTC dates for consistency
      const rs = new Date(accrualCustomStart + 'T00:00:00Z');
      const re = new Date(accrualCustomEnd + 'T23:59:59Z');
      let hv=0, hl=0, hc=0;
      for (const h of historicalData) {
        const hs = new Date(String(h.start_date).slice(0,10) + 'T00:00:00Z');
        const he = new Date(String(h.end_date).slice(0,10) + 'T23:59:59Z');
        // Overlap check
        if (!(he < rs || hs > re)) {
          hv += Number(h.views)||0;
          hl += Number(h.likes)||0;
          hc += Number(h.comments)||0;
        }
      }
      return { views: base.views + hv, likes: base.likes + hl, comments: base.comments + hc };
    }
    return base;
  }, [data, weeklyView, mode, useCustomAccrualDates, showHistorical, historicalData, accrualCustomStart, accrualCustomEnd]);
  
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
        const label = String(chart.data.labels[idx]); 
        const totalDs = chart.data.datasets?.[0]; 
        const v = Array.isArray(totalDs?.data)? Number(totalDs.data[idx]||0):0; 
        const numTxt = new Intl.NumberFormat('id-ID').format(Math.round(v));
        const dateTxt = label;
        
        ctx.save(); 
        ctx.font='bold 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial'; 
        const padX=10, padY=8; 
        const numW = ctx.measureText(numTxt).width;
        ctx.font='11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
        const dateW = ctx.measureText(dateTxt).width;
        const boxW = Math.max(numW, dateW) + padX*2;
        const boxH = 38;
        // Fixed position at top-left corner of chart area
        const bx = left + 10; 
        const by = top + 10; 
        const r=6; 
        
        // Background box
        ctx.fillStyle='rgba(0,0,0,0.75)'; 
        ctx.beginPath(); 
        ctx.moveTo(bx+r,by); ctx.lineTo(bx+boxW-r,by); ctx.quadraticCurveTo(bx+boxW,by,bx+boxW,by+r); 
        ctx.lineTo(bx+boxW,by+boxH-r); ctx.quadraticCurveTo(bx+boxW,by+boxH,bx+boxW-r,by+boxH); 
        ctx.lineTo(bx+r,by+boxH); ctx.quadraticCurveTo(bx,by+boxH,bx,by+boxH-r); 
        ctx.lineTo(bx,by+r); ctx.quadraticCurveTo(bx,by,bx+r,by); 
        ctx.closePath(); ctx.fill(); 
        
        // Number (big, white)
        ctx.font='bold 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
        ctx.fillStyle='#fff'; 
        ctx.fillText(numTxt, bx+padX, by+18);
        
        // Date label (smaller, dimmer)
        ctx.font='11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
        ctx.fillStyle='rgba(255,255,255,0.6)'; 
        ctx.fillText(dateTxt, bx+padX, by+32);
        
        ctx.restore();
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
              <span>Views: <strong className="text-white">{Number(grandTotals.views).toLocaleString('id-ID')}</strong></span>
              <span>Likes: <strong className="text-white">{Number(grandTotals.likes).toLocaleString('id-ID')}</strong></span>
              <span>Comments: <strong className="text-white">{Number(grandTotals.comments).toLocaleString('id-ID')}</strong></span>
              <span>Posts: <strong className="text-white">{totalPosts.toLocaleString('id-ID')}</strong></span>
              {lastUpdatedHuman && (
                <span className="ml-auto text-white/60">Terakhir diperbarui: <strong className="text-white/80">{lastUpdatedHuman}</strong></span>
              )}
            </>
          )}
        </div>
        <div className="mt-3 flex justify-between items-center">
          {mode === 'postdate' ? (
            <div className="flex items-center gap-2">
              <input type="date" value={start} onChange={(e)=>setStart(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
              <span className="text-white/50">s/d</span>
              <input type="date" value={end} onChange={(e)=>setEnd(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input type="date" value={accrualCustomStart} onChange={(e)=>setAccrualCustomStart(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
              <span className="text-white/50">→</span>
              <input type="date" value={accrualCustomEnd} onChange={(e)=>setAccrualCustomEnd(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
            <input
              type="checkbox"
              checked={weeklyView}
              onChange={(e) => setWeeklyView(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-blue-600"
            />
            <span>Tampilan Mingguan</span>
          </label>
        </div>
      </div>


      {/* Controls: Platform, Interval, Metric sejajar */}
      <div className="mb-3 grid grid-cols-3 items-center gap-2 text-xs">
        {/* Left: Platform Filter */}
        <div className="flex items-center gap-2 justify-start">
          <span className="text-white/60">Platform:</span>
          <button className={`px-2 py-1 rounded ${platformFilter==='all'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setPlatformFilter('all')}>Semua</button>
          <button className={`px-2 py-1 rounded flex items-center gap-1 ${platformFilter==='tiktok'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setPlatformFilter('tiktok')}>
            <span className="text-[#38bdf8]">●</span> TikTok
          </button>
          <button className={`px-2 py-1 rounded flex items-center gap-1 ${platformFilter==='instagram'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setPlatformFilter('instagram')}>
            <span className="text-[#f43f5e]">●</span> Instagram
          </button>
        </div>

        {/* Center: Interval */}
        <div className="flex items-center gap-2 justify-center">
          <span className="text-white/60">Interval:</span>
          <button className={`px-2 py-1 rounded ${interval==='daily'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('daily')}>Harian</button>
          <button className={`px-2 py-1 rounded ${interval==='weekly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('weekly')}>Mingguan</button>
          <button className={`px-2 py-1 rounded ${interval==='monthly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('monthly')}>Bulanan</button>
        </div>

        {/* Right: Metric */}
        <div className="flex items-center gap-2 justify-end">
          <span className="text-white/60">Metric:</span>
          <button className={`px-2 py-1 rounded ${metric==='views'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('views')}>Views</button>
          <button className={`px-2 py-1 rounded ${metric==='likes'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('likes')}>Likes</button>
          <button className={`px-2 py-1 rounded ${metric==='comments'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('comments')}>Comments</button>
        </div>
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
                ticks:{ 
                  color:'rgba(255,255,255,0.6)', 
                  autoSkip: false,
                  maxRotation: 90, 
                  minRotation: 45,
                  font: { size: 9 }
                },
                grid:{ color:'rgba(255,255,255,0.06)'}
              },
              y:{ 
                type: 'linear',
                display: true,
                position: 'left',
                ticks:{ color:'rgba(255,255,255,0.6)'}, 
                grid:{ color:'rgba(255,255,255,0.06)'},
                title: {
                  display: false
                }
              },
              y1: {
                type: 'linear',
                display: showPosts,
                position: 'right',
                ticks:{ color:'#a855f7', font: { size: 10 } },
                grid:{ drawOnChartArea: false },
                title: { display: false },
                beginAtZero: true
              }
            },
            onHover: (_e:any, el:any[])=> setActiveIndex(el && el.length>0 ? (el[0].index ?? null) : null)
          }} onMouseLeave={()=> setActiveIndex(null)} />
        )}
      </div>

      {/* Top 5 Video FYP Section (aggregate across all groups when campaignId undefined) */}
      <div className="mt-8">
        <TopViralDashboard 
          days={30} 
          limit={5} 
        />
      </div>
    </div>
  );
}
