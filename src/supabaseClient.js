import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://fkgyeuroojveeovkvhhs.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrZ3lldXJvb2p2ZWVvdmt2aGhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQxMDg2NDYsImV4cCI6MjA2OTY4NDY0Nn0.rKColf4UmF31h3kCHd5UVLuIPvjcw-aLOYcwgbXSRk8';

export const supabase = createClient(supabaseUrl, supabaseKey);
