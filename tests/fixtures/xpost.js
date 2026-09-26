// Synthetic X-like markup (structure captured from x.com 2026-09-26, all text/names fake).
window.xPost = function (p) {
  const photo = p.photo ? `<div data-testid="tweetPhoto"><div><img src="img/otter.svg" alt="Image" width="500" height="300"></div></div>` : '';
  const quote = p.quote ? `<div role="link"><div><div data-testid="Tweet-User-Avatar"><div><img src="img/otter.svg" alt="" width="20" height="20" class="profile_images"></div></div>
      <div data-testid="User-Name"><div><div dir="ltr"><span>${p.quote.name}</span></div></div><div><div dir="ltr"><span>@${p.quote.handle}</span></div><div dir="ltr"><span>·</span></div><div dir="ltr" aria-label="3 hours ago"><time datetime="2026-09-25T18:00:00.000Z">3h</time></div></div></div>
      <div data-testid="tweetText" lang="en" dir="auto"><span>${p.quote.text}</span></div></div></div>` : '';
  const ctx = p.context ? `<div><a href="/${p.context}" role="link"><span data-testid="socialContext">${p.context} reposted</span></a></div>` : '';
  return `<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0"><div>${ctx}
    <div data-testid="Tweet-User-Avatar"><div><a role="link" href="/${p.handle}"><img src="https://pbs.twimg.com/profile_images/1/a.jpg" alt="" width="40" height="40"></a></div></div>
    <div><div data-testid="User-Name"><a role="link" href="/${p.handle}"><div><div dir="ltr"><span><span>${p.name}</span></span></div></div></a>
      <div><a role="link" tabindex="-1" href="/${p.handle}"><div dir="ltr"><span>@${p.handle}</span></div></a><div dir="ltr"><span>·</span></div>
      <a role="link" dir="ltr" aria-label="${p.ago} hours ago" href="${p.href}"><time datetime="${p.datetime}">${p.ago}h</time></a></div></div>
      <button data-testid="caret" role="button" aria-label="More"><svg></svg></button></div>
    <div data-testid="tweetText" lang="en" dir="auto"><span>${p.text}</span></div>${photo}${quote}
    <div role="group" aria-label="${p.replies} replies, ${p.reposts} reposts, ${p.likes} likes, 2 bookmarks, ${p.views} views">
      <button data-testid="reply" role="button" aria-label="${p.replies} Replies. Reply"><span data-testid="app-text-transition-container"><span>${p.replies}</span></span></button>
      <button data-testid="retweet" role="button" aria-label="${p.reposts} reposts. Repost"><span data-testid="app-text-transition-container"><span>${p.reposts}</span></span></button>
      <button data-testid="like" role="button" aria-label="${p.likes} Likes. Like"><span data-testid="app-text-transition-container"><span>${p.likes}</span></span></button>
      <a role="link" aria-label="${p.views} views. View post analytics" href="${p.href}/analytics"><span>${p.views}</span></a>
      <button role="button" aria-label="Share post"><svg></svg></button></div></div></article></div>`;
};
window.xFake = function (i) {
  const names = [['Dana Lee', 'dana_l'], ['Eli Park', 'elipark'], ['Fin Moss', 'finmoss'], ['Gia Rossi', 'giarossi'], ['Hal Ortiz', 'halo']];
  const [name, handle] = names[i % names.length];
  return {
    name, handle, href: i === 0 ? 'xstatus.html' : `/${handle}/status/10000000${i}`, ago: i + 1, datetime: `2026-09-2${i % 6}T1${i % 10}:00:00.000Z`,
    text: `Post number ${i}: shipping a small feature today and writing down what I learned about <a href="https://example.com/p${i}">caching</a> along the way. Thread below.`,
    photo: i % 4 === 1, quote: i === 2 ? { name: 'Quoted Person', handle: 'quoted', text: 'The original quoted post text that people keep sharing around.' } : null,
    context: i === 3 ? 'Some Friend' : '', replies: i * 3, reposts: i * 2, likes: i * 11, views: i * 1000 + 17,
  };
};
