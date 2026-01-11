'use client';

import { useEffect, useState } from 'react';

interface VideoMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  total_engagement: number;
}

interface ViralVideo {
  platform: 'tiktok' | 'instagram';
  video_id: string;
  username: string;
  owner_name: string | null;
  owner_id: string;
  post_date: string;
  link: string;
  metrics: VideoMetrics;
  snapshots_count: number;
}

interface TopVideosResponse {
  videos: ViralVideo[];
  campaign_id: string;
  platform: string;
  start: string;
  end: string;
  days: number;
  total_found: number;
  showing: number;
}

interface TopViralVideosProps {
  campaignId: string;
  platform?: 'all' | 'tiktok' | 'instagram';
  days?: number;
  limit?: number;
}

export default function TopViralVideos({
  campaignId,
  platform = 'all',
  days = 30,
  limit = 10
}: TopViralVideosProps) {
  const [data, setData] = useState<TopVideosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTopVideos = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          campaign_id: campaignId,
          platform,
          days: String(days),
          limit: String(limit)
        });

        const res = await fetch(`/api/leaderboard/top-videos?${params}`);
        
        if (!res.ok) {
          throw new Error(`Failed to fetch: ${res.status}`);
        }

        const json = await res.json();
        setData(json);
      } catch (err: any) {
        setError(err.message || 'Failed to load viral videos');
      } finally {
        setLoading(false);
      }
    };

    fetchTopVideos();
  }, [campaignId, platform, days, limit]);

  const formatNumber = (num: number): string => {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  };

  const getPlatformColor = (platform: string) => {
    return platform === 'tiktok' 
      ? 'bg-black text-white'
      : 'bg-gradient-to-r from-purple-500 via-pink-500 to-orange-500 text-white';
  };

  const getPlatformIcon = (platform: string) => {
    return platform === 'tiktok' ? '🎵' : '📷';
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Top Viral Videos</h2>
          <div className="text-sm text-gray-500">Loading...</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="border rounded-lg p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-3"></div>
              <div className="h-3 bg-gray-200 rounded w-1/2 mb-2"></div>
              <div className="h-3 bg-gray-200 rounded w-2/3"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-300 rounded-lg p-4 bg-red-50">
        <h2 className="text-xl font-bold text-red-700 mb-2">Error Loading Viral Videos</h2>
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  if (!data || data.videos.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center text-gray-500">
        <p className="text-lg">No viral videos found for this campaign</p>
        <p className="text-sm mt-2">Try adjusting the time window or platform filter</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Top Viral Videos 🔥</h2>
        <div className="text-sm text-gray-500">
          {data.showing} of {data.total_found} videos • Last {days} days
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.videos.map((video, index) => (
          <div
            key={`${video.platform}-${video.video_id}`}
            className="border rounded-lg overflow-hidden hover:shadow-lg transition-shadow"
          >
            {/* Ranking Badge */}
            <div className="relative">
              <div className={`absolute top-2 left-2 z-10 w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg ${
                index === 0 ? 'bg-yellow-400 text-yellow-900' :
                index === 1 ? 'bg-gray-300 text-gray-700' :
                index === 2 ? 'bg-orange-400 text-orange-900' :
                'bg-blue-100 text-blue-700'
              }`}>
                #{index + 1}
              </div>

              {/* Platform Badge */}
              <div className={`absolute top-2 right-2 z-10 px-3 py-1 rounded-full text-xs font-semibold ${getPlatformColor(video.platform)}`}>
                {getPlatformIcon(video.platform)} {video.platform.toUpperCase()}
              </div>

              {/* Content */}
              <div className="pt-16 px-4 pb-4">
                <a
                  href={video.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group"
                >
                  <h3 className="font-semibold text-lg mb-1 group-hover:text-blue-600 transition-colors flex items-center gap-2">
                    {video.owner_name || video.username}
                    <svg className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </h3>
                  <p className="text-sm text-gray-600 mb-3">@{video.username}</p>
                </a>

                {/* Metrics */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">👁️ Views</span>
                    <span className="font-bold text-lg">{formatNumber(video.metrics.views)}</span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">❤️ Likes</span>
                      <span className="font-semibold">{formatNumber(video.metrics.likes)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">💬 Comments</span>
                      <span className="font-semibold">{formatNumber(video.metrics.comments)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">🔄 Shares</span>
                      <span className="font-semibold">{formatNumber(video.metrics.shares)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">🔖 Saves</span>
                      <span className="font-semibold">{formatNumber(video.metrics.saves)}</span>
                    </div>
                  </div>

                  <div className="pt-2 border-t flex items-center justify-between">
                    <span className="text-xs text-gray-500">Total Engagement</span>
                    <span className="font-bold text-sm text-blue-600">
                      {formatNumber(video.metrics.total_engagement)}
                    </span>
                  </div>
                </div>

                {/* Footer */}
                <div className="mt-3 pt-3 border-t text-xs text-gray-500 text-center">
                  <span>📊 {video.snapshots_count} snapshot{video.snapshots_count > 1 ? 's' : ''}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Summary Stats */}
      <div className="border-t pt-4 mt-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-blue-600">
              {formatNumber(data.videos.reduce((sum, v) => sum + v.metrics.views, 0))}
            </div>
            <div className="text-sm text-gray-600">Total Views</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-pink-600">
              {formatNumber(data.videos.reduce((sum, v) => sum + v.metrics.likes, 0))}
            </div>
            <div className="text-sm text-gray-600">Total Likes</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-green-600">
              {formatNumber(data.videos.reduce((sum, v) => sum + v.metrics.shares, 0))}
            </div>
            <div className="text-sm text-gray-600">Total Shares</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-purple-600">
              {formatNumber(data.videos.reduce((sum, v) => sum + v.metrics.total_engagement, 0))}
            </div>
            <div className="text-sm text-gray-600">Total Engagement</div>
          </div>
        </div>
      </div>
    </div>
  );
}
