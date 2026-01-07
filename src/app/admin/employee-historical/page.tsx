'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

interface HistoricalEntry {
  id: string;
  employee_id: string;
  campaign_id?: string | null;
  start_date: string;
  end_date: string;
  platform: 'tiktok' | 'instagram' | 'all';
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  notes?: string;
}

interface Employee {
  id: string;
  full_name: string;
  username: string;
}

interface Campaign {
  id: string;
  name: string;
}

export default function EmployeeHistoricalPage() {
  const [entries, setEntries] = useState<HistoricalEntry[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Form state
  const [formData, setFormData] = useState({
    employee_id: '',
    campaign_id: '',
    start_date: '',
    end_date: '',
    platform: 'tiktok' as 'tiktok' | 'instagram' | 'all',
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    notes: ''
  });

  const supabase = createClient();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load employees
      const { data: empData } = await supabase
        .from('users')
        .select('id, full_name, username')
        .eq('role', 'karyawan')
        .order('full_name');
      setEmployees(empData || []);

      // Load campaigns
      const { data: campData } = await supabase
        .from('campaigns')
        .select('id, name')
        .order('name');
      setCampaigns(campData || []);

      // Load historical entries
      const res = await fetch('/api/admin/employee-historical');
      const json = await res.json();
      setEntries(json.data || []);
    } catch (e) {
      console.error('Error loading data:', e);
    }
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.employee_id || !formData.start_date || !formData.end_date) {
      alert('Mohon isi Employee, Tanggal Mulai, dan Tanggal Selesai');
      return;
    }

    try {
      const res = await fetch('/api/admin/employee-historical', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          campaign_id: formData.campaign_id || null
        })
      });

      const json = await res.json();
      
      if (!res.ok) {
        alert(`Error: ${json.error}`);
        return;
      }

      alert('Data berhasil disimpan!');
      setFormData({
        employee_id: '',
        campaign_id: '',
        start_date: '',
        end_date: '',
        platform: 'tiktok',
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        notes: ''
      });
      loadData();
    } catch (e: any) {
      alert('Error: ' + e.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Hapus data historis ini?')) return;

    try {
      const res = await fetch(`/api/admin/employee-historical?id=${id}`, {
        method: 'DELETE'
      });

      if (res.ok) {
        alert('Data berhasil dihapus!');
        loadData();
      } else {
        const json = await res.json();
        alert(`Error: ${json.error}`);
      }
    } catch (e: any) {
      alert('Error: ' + e.message);
    }
  };

  const getEmployeeName = (id: string) => {
    const emp = employees.find(e => e.id === id);
    return emp ? `${emp.full_name} (@${emp.username})` : id;
  };

  const getCampaignName = (id?: string | null) => {
    if (!id) return 'Semua Campaign';
    const camp = campaigns.find(c => c.id === id);
    return camp ? camp.name : id;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-6">Data Historis Employee</h1>
        
        {/* Form Input */}
        <div className="glass rounded-2xl p-6 border border-white/10 mb-6">
          <h2 className="text-xl font-semibold text-white mb-4">Tambah Data Historis</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Employee */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Employee *</label>
                <select
                  value={formData.employee_id}
                  onChange={(e) => setFormData({ ...formData, employee_id: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  required
                >
                  <option value="">Pilih Employee</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id} className="text-black">
                      {emp.full_name} (@{emp.username})
                    </option>
                  ))}
                </select>
              </div>

              {/* Campaign */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Campaign (Opsional)</label>
                <select
                  value={formData.campaign_id}
                  onChange={(e) => setFormData({ ...formData, campaign_id: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                >
                  <option value="">Semua Campaign</option>
                  {campaigns.map(camp => (
                    <option key={camp.id} value={camp.id} className="text-black">
                      {camp.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Start Date */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Tanggal Mulai *</label>
                <input
                  type="date"
                  value={formData.start_date}
                  onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  required
                />
              </div>

              {/* End Date */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Tanggal Selesai *</label>
                <input
                  type="date"
                  value={formData.end_date}
                  onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  required
                />
              </div>

              {/* Platform */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Platform *</label>
                <select
                  value={formData.platform}
                  onChange={(e) => setFormData({ ...formData, platform: e.target.value as any })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  required
                >
                  <option value="all">All (TikTok + Instagram)</option>
                  <option value="tiktok">TikTok Only</option>
                  <option value="instagram">Instagram Only</option>
                </select>
              </div>

              {/* Views */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Views</label>
                <input
                  type="number"
                  value={formData.views}
                  onChange={(e) => setFormData({ ...formData, views: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  min="0"
                />
              </div>

              {/* Likes */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Likes</label>
                <input
                  type="number"
                  value={formData.likes}
                  onChange={(e) => setFormData({ ...formData, likes: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  min="0"
                />
              </div>

              {/* Comments */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Comments</label>
                <input
                  type="number"
                  value={formData.comments}
                  onChange={(e) => setFormData({ ...formData, comments: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  min="0"
                />
              </div>

              {/* Shares */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Shares</label>
                <input
                  type="number"
                  value={formData.shares}
                  onChange={(e) => setFormData({ ...formData, shares: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  min="0"
                />
              </div>

              {/* Saves */}
              <div>
                <label className="block text-sm text-white/70 mb-1">Saves</label>
                <input
                  type="number"
                  value={formData.saves}
                  onChange={(e) => setFormData({ ...formData, saves: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                  min="0"
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm text-white/70 mb-1">Catatan (Opsional)</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white"
                rows={2}
                placeholder="Contoh: Data dari periode Agustus 2025"
              />
            </div>

            <button
              type="submit"
              className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors"
            >
              Simpan Data Historis
            </button>
          </form>
        </div>

        {/* Data Table */}
        <div className="glass rounded-2xl p-6 border border-white/10">
          <h2 className="text-xl font-semibold text-white mb-4">Data yang Sudah Diinput ({entries.length})</h2>
          
          {entries.length === 0 ? (
            <p className="text-white/60 text-center py-8">Belum ada data historis</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-white/70 py-2 px-2">Employee</th>
                    <th className="text-left text-white/70 py-2 px-2">Campaign</th>
                    <th className="text-left text-white/70 py-2 px-2">Periode</th>
                    <th className="text-left text-white/70 py-2 px-2">Platform</th>
                    <th className="text-right text-white/70 py-2 px-2">Views</th>
                    <th className="text-right text-white/70 py-2 px-2">Likes</th>
                    <th className="text-right text-white/70 py-2 px-2">Comments</th>
                    <th className="text-center text-white/70 py-2 px-2">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => (
                    <tr key={entry.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="text-white py-3 px-2">{getEmployeeName(entry.employee_id)}</td>
                      <td className="text-white/80 py-3 px-2">{getCampaignName(entry.campaign_id)}</td>
                      <td className="text-white/80 py-3 px-2">
                        {new Date(entry.start_date).toLocaleDateString('id-ID')} - {new Date(entry.end_date).toLocaleDateString('id-ID')}
                      </td>
                      <td className="text-white/80 py-3 px-2 uppercase">{entry.platform}</td>
                      <td className="text-right text-white/80 py-3 px-2">{entry.views.toLocaleString('id-ID')}</td>
                      <td className="text-right text-white/80 py-3 px-2">{entry.likes.toLocaleString('id-ID')}</td>
                      <td className="text-right text-white/80 py-3 px-2">{entry.comments.toLocaleString('id-ID')}</td>
                      <td className="text-center py-3 px-2">
                        <button
                          onClick={() => handleDelete(entry.id)}
                          className="text-red-400 hover:text-red-300 text-xs px-3 py-1 border border-red-400/30 rounded hover:bg-red-400/10"
                        >
                          Hapus
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="glass rounded-2xl p-6 border border-white/10 mt-6">
          <h3 className="text-lg font-semibold text-white mb-2">Petunjuk Penggunaan</h3>
          <ul className="text-white/70 text-sm space-y-1 list-disc list-inside">
            <li>Pilih employee yang ingin diinput data historisnya</li>
            <li>Tentukan periode custom (dari tanggal berapa sampai tanggal berapa)</li>
            <li>Pilih platform: All (gabungan TikTok+Instagram), TikTok Only, atau Instagram Only</li>
            <li>Input metrics: views, likes, comments, shares, saves</li>
            <li>Data akan muncul di chart employee di /dashboard/groups ketika employee dipilih</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
