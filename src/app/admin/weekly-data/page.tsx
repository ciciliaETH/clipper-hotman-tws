'use client';

import { useState, useEffect } from 'react';

interface WeeklyData {
  id?: number;
  week_label: string;
  year: number;
  campaign_id?: string;
  group_name?: string;
  platform: 'tiktok' | 'instagram' | 'all';
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  notes?: string;
}

export default function WeeklyDataInput() {
  const [formData, setFormData] = useState<WeeklyData>({
    week_label: '',
    year: new Date().getFullYear(),
    platform: 'all',
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0
  });
  
  const [existingData, setExistingData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  
  // Load existing data
  const loadData = async () => {
    try {
      const res = await fetch(`/api/admin/weekly-data?year=${formData.year}`);
      const json = await res.json();
      if (res.ok) setExistingData(json.data || []);
    } catch (error) {
      console.error('Failed to load data:', error);
    }
  };
  
  useEffect(() => {
    loadData();
  }, [formData.year]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    
    try {
      const res = await fetch('/api/admin/weekly-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      
      const json = await res.json();
      
      if (res.ok) {
        setMessage({ type: 'success', text: 'Data berhasil disimpan!' });
        setFormData({
          ...formData,
          week_label: '',
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          saves: 0,
          notes: ''
        });
        loadData();
      } else {
        setMessage({ type: 'error', text: json.error || 'Gagal menyimpan data' });
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };
  
  const handleDelete = async (id: number) => {
    if (!confirm('Yakin ingin menghapus data ini?')) return;
    
    try {
      const res = await fetch(`/api/admin/weekly-data?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Data berhasil dihapus!' });
        loadData();
      } else {
        const json = await res.json();
        setMessage({ type: 'error', text: json.error || 'Gagal menghapus data' });
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f3460] p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-6">📊 Input Data Mingguan</h1>
        
        {/* Form */}
        <div className="glass rounded-2xl p-6 mb-6 border border-white/10">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Week Label */}
              <div>
                <label className="block text-white/80 text-sm mb-2">Week Label</label>
                <input
                  type="text"
                  placeholder="W1 Agustus"
                  value={formData.week_label}
                  onChange={(e) => setFormData({ ...formData, week_label: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-white/30"
                  required
                />
                <p className="text-xs text-white/50 mt-1">Format: W1 Agustus, W2 September, dst</p>
              </div>
              
              {/* Year */}
              <div>
                <label className="block text-white/80 text-sm mb-2">Tahun</label>
                <input
                  type="number"
                  value={formData.year}
                  onChange={(e) => setFormData({ ...formData, year: parseInt(e.target.value) })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white"
                  required
                />
              </div>
              
              {/* Platform */}
              <div>
                <label className="block text-white/80 text-sm mb-2">Platform</label>
                <select
                  value={formData.platform}
                  onChange={(e) => setFormData({ ...formData, platform: e.target.value as any })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white"
                >
                  <option value="all">Semua</option>
                  <option value="tiktok">TikTok</option>
                  <option value="instagram">Instagram</option>
                </select>
              </div>
              
              {/* Group Name */}
              <div>
                <label className="block text-white/80 text-sm mb-2">Group/Campaign (Opsional)</label>
                <input
                  type="text"
                  placeholder="e.g., Campaign A"
                  value={formData.group_name || ''}
                  onChange={(e) => setFormData({ ...formData, group_name: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-white/30"
                />
              </div>
            </div>
            
            {/* Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div>
                <label className="block text-white/80 text-sm mb-2">Views</label>
                <input
                  type="number"
                  value={formData.views}
                  onChange={(e) => setFormData({ ...formData, views: parseInt(e.target.value) || 0 })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white"
                />
              </div>
              <div>
                <label className="block text-white/80 text-sm mb-2">Likes</label>
                <input
                  type="number"
                  value={formData.likes}
                  onChange={(e) => setFormData({ ...formData, likes: parseInt(e.target.value) || 0 })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white"
                />
              </div>
              <div>
                <label className="block text-white/80 text-sm mb-2">Comments</label>
                <input
                  type="number"
                  value={formData.comments}
                  onChange={(e) => setFormData({ ...formData, comments: parseInt(e.target.value) || 0 })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white"
                />
              </div>
              <div>
                <label className="block text-white/80 text-sm mb-2">Shares</label>
                <input
                  type="number"
                  value={formData.shares}
                  onChange={(e) => setFormData({ ...formData, shares: parseInt(e.target.value) || 0 })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white"
                />
              </div>
              <div>
                <label className="block text-white/80 text-sm mb-2">Saves</label>
                <input
                  type="number"
                  value={formData.saves}
                  onChange={(e) => setFormData({ ...formData, saves: parseInt(e.target.value) || 0 })}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white"
                />
              </div>
            </div>
            
            {/* Notes */}
            <div>
              <label className="block text-white/80 text-sm mb-2">Catatan (Opsional)</label>
              <textarea
                value={formData.notes || ''}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-white/30 resize-none"
                rows={2}
                placeholder="Tambahkan catatan jika perlu..."
              />
            </div>
            
            {/* Submit */}
            <div className="flex items-center gap-4">
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition"
              >
                {loading ? 'Menyimpan...' : '💾 Simpan Data'}
              </button>
              
              {message && (
                <p className={`text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                  {message.text}
                </p>
              )}
            </div>
          </form>
        </div>
        
        {/* Existing Data */}
        <div className="glass rounded-2xl p-6 border border-white/10">
          <h2 className="text-xl font-bold text-white mb-4">Data Tersimpan ({existingData.length})</h2>
          
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-white/80">
              <thead className="text-white/60 border-b border-white/10">
                <tr>
                  <th className="text-left py-2 px-3">Week</th>
                  <th className="text-left py-2 px-3">Periode</th>
                  <th className="text-left py-2 px-3">Platform</th>
                  <th className="text-right py-2 px-3">Views</th>
                  <th className="text-right py-2 px-3">Likes</th>
                  <th className="text-right py-2 px-3">Comments</th>
                  <th className="text-center py-2 px-3">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {existingData.map((item) => (
                  <tr key={item.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-2 px-3">{item.week_label}</td>
                    <td className="py-2 px-3 text-xs">{item.start_date} → {item.end_date}</td>
                    <td className="py-2 px-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        item.platform === 'tiktok' ? 'bg-blue-500/20 text-blue-300' :
                        item.platform === 'instagram' ? 'bg-pink-500/20 text-pink-300' :
                        'bg-purple-500/20 text-purple-300'
                      }`}>
                        {item.platform}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right">{item.views?.toLocaleString()}</td>
                    <td className="py-2 px-3 text-right">{item.likes?.toLocaleString()}</td>
                    <td className="py-2 px-3 text-right">{item.comments?.toLocaleString()}</td>
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={() => handleDelete(item.id)}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >
                        🗑️ Hapus
                      </button>
                    </td>
                  </tr>
                ))}
                
                {existingData.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-white/40">
                      Belum ada data. Silakan input data di form di atas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
