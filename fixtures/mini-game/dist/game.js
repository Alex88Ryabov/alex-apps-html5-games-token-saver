// A minimal CrazyGames game. Each query flag breaks one reviewer rule, so the same build serves
// both the clean run and every failure: ?nopause ?renderreads ?save=60 ?nohidesave ?local ?loud
// ?nocooldown ?unequal ?small ?tall ?doublestart
(function () {
  const flags = new URLSearchParams(location.search);
  const SDK = window.CrazyGames.SDK;
  const KEY = 'mini.save';
  const saveEveryMs = Number(flags.get('save') || 30) * 1000;
  let score = 0;
  let music = null;
  let cooldownUntil = 0;

  const save = () => {
    SDK.data.setItem(KEY, JSON.stringify({ score }));
    if (flags.has('local')) {
      localStorage.setItem(KEY, String(score));
    }
  };

  const startMusic = () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    music = gain;
  };

  SDK.init().then(() => {
    SDK.game.loadingStart();
    // Read once at connect: the right way.
    const account = SDK.user.isUserAccountAvailable;
    document.body.dataset.account = String(account);
    SDK.game.loadingStop();
    if (flags.has('renderreads')) {
      setInterval(() => {
        document.body.dataset.account = String(SDK.user.isUserAccountAvailable);
      }, 100);
    }
  });

  document.getElementById('play').addEventListener('click', () => {
    SDK.game.gameplayStart();
    if (flags.has('doublestart')) {
      SDK.game.gameplayStart();
    }
    startMusic();
    setInterval(() => {
      score++;
      document.getElementById('score').textContent = String(score);
    }, 500);
    setInterval(save, saveEveryMs);
  });

  const dialog = document.getElementById('settings-dialog');
  if (flags.has('tall')) {
    dialog.classList.add('tall');
  }
  if (flags.has('small')) {
    document.body.classList.add('small');
  }
  if (flags.has('unequal')) {
    document.getElementById('offer').classList.add('unequal');
  }
  document.getElementById('settings').addEventListener('click', () => {
    dialog.hidden = false;
    if (!flags.has('nopause')) {
      SDK.game.gameplayStop();
    }
  });
  document.getElementById('close').addEventListener('click', () => {
    dialog.hidden = true;
    if (!flags.has('nopause')) {
      SDK.game.gameplayStart();
    }
  });

  const rewarded = document.getElementById('rewarded');
  rewarded.addEventListener('click', () => {
    if (Date.now() < cooldownUntil) {
      return;
    }
    SDK.ad.requestAd('rewarded', {
      adStarted: () => {
        if (music && !flags.has('loud')) {
          music.gain.value = 0;
        }
      },
      adFinished: () => {
        if (music) {
          music.gain.value = 0.2;
        }
        score += 10;
        if (!flags.has('nocooldown')) {
          cooldownUntil = Date.now() + 60_000;
          rewarded.disabled = true;
        }
      },
      adError: () => {},
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !flags.has('nohidesave')) {
      save();
    }
  });
})();
