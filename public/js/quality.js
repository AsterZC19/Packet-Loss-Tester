// public/js/quality.js
// A–F quality rating combining loss, latency and jitter, plus a plain-language
// reason string. Thresholds:
//   loss 0% ideal · <1% acceptable · 1–2.5% problematic for games/VoIP · >5% severe
export function gradeQuality({ uploadLossPct, downloadLossPct, avgRtt, jitterAvg }) {
  const loss = Math.max(uploadLossPct, downloadLossPct);

  let score = 100;
  const issues = [];

  if (loss <= 0.5) {
    // no penalty
  } else if (loss < 1) {
    score -= 5;
    issues.push('轻微丢包');
  } else if (loss < 2.5) {
    score -= 20;
    issues.push('丢包会影响游戏/语音');
  } else if (loss < 5) {
    score -= 45;
    issues.push('明显丢包');
  } else {
    score -= 70;
    issues.push('严重丢包');
  }

  if (avgRtt < 20) {
    // no penalty
  } else if (avgRtt < 50) {
    score -= 5;
    issues.push('延迟偏高');
  } else if (avgRtt < 100) {
    score -= 15;
    issues.push('延迟较高');
  } else if (avgRtt < 200) {
    score -= 30;
    issues.push('延迟过高');
  } else {
    score -= 50;
    issues.push('延迟不可用');
  }

  if (jitterAvg < 5) {
    // no penalty
  } else if (jitterAvg < 15) {
    score -= 5;
    issues.push('抖动偏高');
  } else if (jitterAvg < 30) {
    score -= 15;
    issues.push('抖动明显');
  } else {
    score -= 30;
    issues.push('抖动严重');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade, color, tint, ink;
  if (score >= 90) {
    grade = 'A';
    color = '#15795a';
    tint = '#e6f4ee';
    ink = '#15795a';
  } else if (score >= 75) {
    grade = 'B';
    color = '#1e9e74';
    tint = '#e6f4ee';
    ink = '#15795a';
  } else if (score >= 60) {
    grade = 'C';
    color = '#f9b417';
    tint = '#fef5e0';
    ink = '#8a6008';
  } else if (score >= 40) {
    grade = 'D';
    color = '#f2792b';
    tint = '#fef5e0';
    ink = '#8a6008';
  } else {
    grade = 'F';
    color = '#ef4b41';
    tint = '#fdecea';
    ink = '#b93227';
  }

  let reason;
  if (issues.length === 0) {
    reason = '网络质量优秀,适合游戏、语音和视频通话。';
  } else {
    reason = `主要问题:${issues.join('、')}。${loss >= 5 ? '丢包已属严重,建议检查网线/路由器或联系运营商。' : ''}`;
  }

  return { score, grade, color, tint, ink, reason, loss };
}
