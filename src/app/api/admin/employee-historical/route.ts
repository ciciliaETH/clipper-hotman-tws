import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Create admin client with service role key
function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// GET: Fetch employee historical metrics
export async function GET() { return NextResponse.json({ data: [] }); }

// POST: Create new historical metric (aggregate total data)
export async function POST() { return NextResponse.json({ ok: true, message: 'Historical disabled' }); }

// PUT: Update existing employee historical metric
export async function PUT() { return NextResponse.json({ ok: true, message: 'Historical disabled' }); }

// DELETE: Remove employee historical metric
export async function DELETE() { return NextResponse.json({ ok: true, message: 'Historical disabled' }); }
