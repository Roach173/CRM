const { execSync } = require('child_process');
try {
  execSync('git --no-pager checkout HEAD -- src/pages/dashboard/admin/Schedule.tsx', { cwd: __dirname, stdio: 'inherit' });
  console.log('Restored correctly');
} catch (e) {
  console.error(e);
}
