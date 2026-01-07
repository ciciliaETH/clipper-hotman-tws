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

// GET: Fetch all employees (unique employee_id from employee_accounts table)
export async function GET() {
  try {
    const supabase = createAdminClient();
    
    // First check if employee_accounts has data
    const { data: empAccounts, error: empError } = await supabase
      .from('employee_accounts')
      .select('employee_id')
      .limit(10);

    console.log('[DEBUG] Employee accounts found:', empAccounts?.length || 0);
    
    // If no employee_accounts, return all users instead
    if (!empAccounts || empAccounts.length === 0) {
      console.log('[DEBUG] No employee_accounts, fetching all users...');
      const { data: allUsers, error: usersError } = await supabase
        .from('users')
        .select('id, username, full_name')
        .order('username');
      
      console.log('[DEBUG] All users found:', allUsers?.length || 0);
      
      const users = allUsers?.map(u => ({
        id: u.id,
        username: u.username,
        full_name: u.full_name,
        display_name: u.full_name || u.username
      })) || [];
      
      return NextResponse.json({ data: users });
    }
    
    // Get distinct employee IDs from employee_accounts, join with users for names
    const { data, error } = await supabase
      .from('employee_accounts')
      .select(`
        employee_id,
        users!employee_accounts_employee_id_fkey (
          id,
          username,
          full_name
        )
      `)
      .order('employee_id', { ascending: true });

    if (error) {
      console.error('Error fetching employees:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[DEBUG] Joined data rows:', data?.length || 0);

    // Extract unique employees
    const uniqueEmployees = new Map();
    data?.forEach((row: any) => {
      const user = row.users;
      if (user && !uniqueEmployees.has(user.id)) {
        uniqueEmployees.set(user.id, {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          display_name: user.full_name || user.username
        });
      }
    });

    const employees = Array.from(uniqueEmployees.values());
    
    console.log('[DEBUG] Unique employees:', employees.length);

    return NextResponse.json({ data: employees });
  } catch (error: any) {
    console.error('Error in GET /api/employees:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
