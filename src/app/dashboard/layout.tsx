'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { User } from '@/types';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FiLogOut, FiUsers, FiBarChart, FiTrendingUp, FiMenu, FiX } from 'react-icons/fi';
import { FiSettings } from 'react-icons/fi';
import Image from 'next/image';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const getUser = async () => {
      try {
        const {
          data: { user: authUser },
        } = await supabase.auth.getUser();

        if (!authUser) {
          router.push('/login');
          return;
        }

        // Ganti query langsung ke tabel users dengan RPC
        const { data: userData, error: rpcError } = await supabase
          .rpc('get_user_profile')
          .single();

        if (rpcError) {
          console.error('Error fetching user profile via RPC:', rpcError);
          router.push('/login');
          return;
        }

        if (userData) {
          setUser(userData as User);
        }
      } catch (error) {
        console.error('Error fetching user:', error);
        router.push('/login');
      } finally {
        setLoading(false);
      }
    };

    getUser();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen">
      {/* Navbar */}
      <nav className="sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
        <div className="backdrop-blur-xl bg-gradient-to-r from-blue-600/10 via-sky-500/10 to-blue-400/10 glass border-b border-white/10">
          {/* Wider, fluid container so kanan-kiri tidak kosong di layar lebar */}
          <div className="w-full max-w-screen-2xl mx-auto px-3 sm:px-6 lg:px-8 xl:px-10">
            <div className="flex justify-between items-center h-14 sm:h-16">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <div className="relative w-9 h-9 sm:w-10 sm:h-10 shrink-0">
                  <Image
                    src="/logo.png"
                    alt="Trade With Suli"
                    width={40}
                    height={40}
                    className="w-full h-full object-contain"
                    priority
                  />
                </div>
                <h1 className="hidden sm:block text-lg sm:text-xl font-semibold tracking-tight whitespace-nowrap overflow-hidden text-ellipsis max-w-[40vw]"><span className="bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">Trade With Suli</span></h1>
                <span className="hidden md:inline-flex text-xs px-2 py-1 rounded-full bg-white/5 border border-white/10 text-white/60 shrink-0">Clipper</span>
              </div>

              <div className="flex items-center gap-2 sm:gap-4">
                {/* Desktop nav */}
                <div className="hidden lg:flex items-center gap-2">
                  <Link href="/leaderboard" className="flex items-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition">
                    <FiBarChart size={18} />
                    <span className="text-sm font-medium">Leaderboard</span>
                  </Link>

                  <Link href="/dashboard" className="flex items-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition">
                    <FiTrendingUp size={18} />
                    <span className="text-sm font-medium">Analytics</span>
                  </Link>

                  {(user.role === 'admin' || user.role === 'super_admin') && (
                    <Link href="/dashboard/admin" className="flex items-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition">
                      <FiUsers size={18} />
                      <span className="text-sm font-medium">Admin</span>
                    </Link>
                  )}
                  {/* Groups removed */}
                  {/* <Link href="/dashboard/groups" className="flex items-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition">
                    <FiTrendingUp size={18} />
                    <span className="text-sm font-medium">Groups</span>
                  </Link> */}
                  <Link href="/dashboard/account" className="flex items-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition">
                    <FiSettings size={18} />
                    <span className="text-sm font-medium">Akun</span>
                  </Link>
                </div>

                {/* User block (desktop) */}
                <div className="hidden lg:flex items-center gap-3 pl-4 border-l border-white/10">
                  <div className="text-right min-w-0">
                    <p className="text-sm font-medium text-white/90 truncate max-w-[160px]">{user.full_name || user.username}</p>
                    <p className="text-xs text-white/60">
                      {user.role === 'super_admin' ? 'super admin' : user.role}
                    </p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="p-2 rounded-lg text-white/80 hover:text-white hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition"
                    title="Logout"
                  >
                    <FiLogOut size={18} />
                  </button>
                </div>

                {/* Mobile menu button */}
                <button
                  onClick={() => setMenuOpen(v => !v)}
                  className="lg:hidden p-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 border border-white/10"
                  aria-label="Toggle menu"
                  aria-expanded={menuOpen}
                >
                  {menuOpen ? <FiX size={18} /> : <FiMenu size={18} />}
                </button>
              </div>
            </div>
            {/* Mobile dropdown */}
            {menuOpen && (
              <div className="lg:hidden border-t border-white/10 py-2">
                <div className="flex flex-col gap-1">
                  <Link href="/leaderboard" onClick={()=>setMenuOpen(false)} className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition text-center w-full">
                    <FiBarChart size={18} />
                    <span className="text-sm font-medium">Leaderboard</span>
                  </Link>
                  <Link href="/dashboard" onClick={()=>setMenuOpen(false)} className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition text-center w-full">
                    <FiTrendingUp size={18} />
                    <span className="text-sm font-medium">Analytics</span>
                  </Link>
                  {(user.role === 'admin' || user.role === 'super_admin') && (
                    <Link href="/dashboard/admin" onClick={()=>setMenuOpen(false)} className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition text-center w-full">
                      <FiUsers size={18} />
                      <span className="text-sm font-medium">Admin</span>
                    </Link>
                  )}
                  {/* Groups removed in mobile menu */}
                  <Link href="/dashboard/account" onClick={()=>setMenuOpen(false)} className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-white/80 hover:text-white hover:bg-white/5 transition text-center w-full">
                    <FiSettings size={18} />
                    <span className="text-sm font-medium">Akun</span>
                  </Link>
                  <div className="flex items-center justify-between gap-3 px-3 pt-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white/90 truncate">{user.full_name || user.username}</p>
                      <p className="text-xs text-white/60">{user.role === 'super_admin' ? 'super admin' : user.role}</p>
                    </div>
                    <button
                      onClick={async ()=>{ setMenuOpen(false); await handleLogout(); }}
                      className="p-2 rounded-lg text-white/80 hover:text-white hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition"
                      title="Logout"
                    >
                      <FiLogOut size={18} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      {/* Konten utama juga dibuat lebih lebar dan responsif */}
      <main className="w-full max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-6 md:py-8">
        {children}
      </main>
    </div>
  );
}
