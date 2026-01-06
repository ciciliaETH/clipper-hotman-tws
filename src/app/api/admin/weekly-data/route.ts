import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Parse week label to get week number and month name
function parseWeekLabel(label: string): { weekNum: number; monthName: string } | null {
  const match = label.match(/W(\d+)\s+(\w+)/i)
  if (!match) return null
  return { weekNum: parseInt(match[1]), monthName: match[2] }
}

// Map Indonesian month names to numbers
function monthNameToNumber(name: string): number {
  const months: Record<string, number> = {
    'januari': 1, 'februari': 2, 'maret': 3, 'april': 4,
    'mei': 5, 'juni': 6, 'juli': 7, 'agustus': 8,
    'september': 9, 'oktober': 10, 'november': 11, 'desember': 12
  }
  return months[name.toLowerCase()] || 0
}

// Calculate start and end dates based on week number
function calculateWeekDates(year: number, month: number, weekNum: number): { start: string; end: string } {
  const monthStart = new Date(year, month - 1, 1)
  const startDay = 1 + (weekNum - 1) * 7
  const endDay = Math.min(startDay + 6, new Date(year, month, 0).getDate())
  
  const start = new Date(year, month - 1, startDay)
  const end = new Date(year, month - 1, endDay)
  
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  }
}

// GET: Fetch weekly data
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())
    const month = searchParams.get('month') ? parseInt(searchParams.get('month')!) : undefined
    const campaignId = searchParams.get('campaign_id')
    const platform = searchParams.get('platform')
    
    const supabase = adminClient()
    let query = supabase
      .from('weekly_historical_data')
      .select('*')
      .eq('year', year)
      .order('month', { ascending: true })
      .order('week_num', { ascending: true })
    
    if (month) query = query.eq('month', month)
    if (campaignId) query = query.eq('campaign_id', campaignId)
    if (platform) query = query.eq('platform', platform)
    
    const { data, error } = await query
    
    if (error) throw error
    
    return NextResponse.json({ data, count: data?.length || 0 })
  } catch (error: any) {
    console.error('[weekly-data GET] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST: Create new weekly data entry
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      week_label,
      year,
      campaign_id,
      group_name,
      platform,
      views = 0,
      likes = 0,
      comments = 0,
      shares = 0,
      saves = 0,
      notes
    } = body
    
    if (!week_label || !year || !platform) {
      return NextResponse.json(
        { error: 'Missing required fields: week_label, year, platform' },
        { status: 400 }
      )
    }
    
    // Parse week label
    const parsed = parseWeekLabel(week_label)
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid week_label format. Use "W1 Agustus" format' }, { status: 400 })
    }
    
    const month = monthNameToNumber(parsed.monthName)
    if (month === 0) {
      return NextResponse.json({ error: 'Invalid month name in week_label' }, { status: 400 })
    }
    
    // Calculate dates
    const dates = calculateWeekDates(year, month, parsed.weekNum)
    
    const supabase = adminClient()
    const { data, error } = await supabase
      .from('weekly_historical_data')
      .insert({
        week_label,
        start_date: dates.start,
        end_date: dates.end,
        year,
        month,
        week_num: parsed.weekNum,
        campaign_id: campaign_id || null,
        group_name: group_name || null,
        platform,
        views,
        likes,
        comments,
        shares,
        saves,
        notes
      })
      .select()
      .single()
    
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Duplicate entry. This week data already exists.' }, { status: 409 })
      }
      throw error
    }
    
    return NextResponse.json({ data, message: 'Weekly data created successfully' }, { status: 201 })
  } catch (error: any) {
    console.error('[weekly-data POST] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PUT: Update existing weekly data
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, views, likes, comments, shares, saves, notes } = body
    
    if (!id) {
      return NextResponse.json({ error: 'Missing required field: id' }, { status: 400 })
    }
    
    const supabase = adminClient()
    const { data, error } = await supabase
      .from('weekly_historical_data')
      .update({ views, likes, comments, shares, saves, notes })
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    
    return NextResponse.json({ data, message: 'Weekly data updated successfully' })
  } catch (error: any) {
    console.error('[weekly-data PUT] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// DELETE: Remove weekly data
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    
    if (!id) {
      return NextResponse.json({ error: 'Missing required parameter: id' }, { status: 400 })
    }
    
    const supabase = adminClient()
    const { error } = await supabase
      .from('weekly_historical_data')
      .delete()
      .eq('id', id)
    
    if (error) throw error
    
    return NextResponse.json({ message: 'Weekly data deleted successfully' })
  } catch (error: any) {
    console.error('[weekly-data DELETE] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
