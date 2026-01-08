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
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const employeeId = searchParams.get('employee_id');
    const platform = searchParams.get('platform');
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

    const supabase = createAdminClient();
    let query = supabase
      .from('employee_historical_metrics')
      .select(`
        id,
        start_date,
        end_date,
        platform,
        views,
        likes,
        comments,
        shares,
        saves,
        notes,
        created_at,
        updated_at
      `)
      .order('start_date', { ascending: false });

    if (platform && platform !== 'all' && platform !== '') {
      query = query.eq('platform', platform);
    }
    if (startDate) {
      query = query.gte('end_date', startDate);
    }
    if (endDate) {
      query = query.lte('start_date', endDate);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching employee historical metrics:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error: any) {
    console.error('Error in GET /api/admin/employee-historical:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST: Create new historical metric (aggregate total data)
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      start_date,
      end_date,
      platform,
      views = 0,
      likes = 0,
      comments = 0,
      shares = 0,
      saves = 0,
      notes = ''
    } = body;

    // Validation
    if (!start_date || !end_date || !platform) {
      return NextResponse.json(
        { error: 'Missing required fields: start_date, end_date, platform' },
        { status: 400 }
      );
    }

    // Validate date range
    if (new Date(start_date) > new Date(end_date)) {
      return NextResponse.json(
        { error: 'Tanggal mulai harus sebelum atau sama dengan tanggal akhir' },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Check for overlapping periods
    const { data: existing, error: checkError } = await supabase
      .from('employee_historical_metrics')
      .select('id, start_date, end_date')
      .eq('platform', platform)
      .or(`and(start_date.lte.${end_date},end_date.gte.${start_date})`);

    if (checkError) {
      console.error('Error checking for overlap:', checkError);
    } else if (existing && existing.length > 0) {
      return NextResponse.json(
        { error: `Periode ${start_date} s/d ${end_date} overlap dengan data yang sudah ada untuk platform ${platform}` },
        { status: 409 }
      );
    }

    // Insert new record
    const { data, error } = await supabase
      .from('employee_historical_metrics')
      .insert({
        start_date,
        end_date,
        platform,
        views: Number(views) || 0,
        likes: Number(likes) || 0,
        comments: Number(comments) || 0,
        shares: Number(shares) || 0,
        saves: Number(saves) || 0,
        notes: notes || null
      })
      .select()
      .single();

    if (error) {
      console.error('Error inserting employee historical metric:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (error: any) {
    console.error('Error in POST /api/admin/employee-historical:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PUT: Update existing employee historical metric
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const {
      id,
      views,
      likes,
      comments,
      shares,
      saves,
      notes
    } = body;

    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    const supabase = createAdminClient();

    const updateData: any = {};
    if (views !== undefined) updateData.views = Number(views) || 0;
    if (likes !== undefined) updateData.likes = Number(likes) || 0;
    if (comments !== undefined) updateData.comments = Number(comments) || 0;
    if (shares !== undefined) updateData.shares = Number(shares) || 0;
    if (saves !== undefined) updateData.saves = Number(saves) || 0;
    if (notes !== undefined) updateData.notes = notes || null;

    const { data, error } = await supabase
      .from('employee_historical_metrics')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating employee historical metric:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error: any) {
    console.error('Error in PUT /api/admin/employee-historical:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE: Remove employee historical metric
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    const supabase = createAdminClient();

    const { error } = await supabase
      .from('employee_historical_metrics')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting employee historical metric:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error in DELETE /api/admin/employee-historical:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
