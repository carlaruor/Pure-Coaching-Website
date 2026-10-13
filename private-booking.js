'use strict';

(() => {
  const cards = [...document.querySelectorAll('.package-card[data-package]')];
  if (!cards.length) return;
  const panel = document.createElement('section');
  panel.id = 'private-booking-panel';
  panel.className = 'private-booking';
  panel.hidden = true;
  panel.inert = true;
  panel.setAttribute('aria-labelledby', 'booking-title');
  panel.setAttribute('aria-describedby', 'booking-description');
  panel.innerHTML = `
    <div class="private-booking__inner">
      <form class="private-booking__form">
        <p class="private-booking__package" aria-live="polite"></p>
        <h2 id="booking-title" tabindex="-1">Your preferred availability</h2>
        <p id="booking-description">Select the days and times that work best for you. You can choose more than one day.</p>
        <fieldset><legend>Preferred days</legend><div class="private-booking__days"></div></fieldset>
        <p class="private-booking__error" role="alert" id="booking-days-error"></p>
        <fieldset><legend>Preferred time of day</legend><div class="private-booking__times"></div></fieldset>
        <label class="private-booking__notes" for="booking-notes">Specific times or additional preferences
          <textarea id="booking-notes" rows="4" maxlength="2000" placeholder="e.g. Mondays after 9 AM, Wednesdays around 2 PM..."></textarea>
        </label>
        <p class="private-booking__notice">Your selected days and times are preferences, not confirmed bookings. Our team will contact you to arrange your sessions.</p>
        <p class="private-booking__storage-error" role="alert"></p>
        <button class="button button--primary" type="submit">Continue</button>
      </form>
    </div>`;
  const form = panel.querySelector('form');
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const times = ['Morning (6 AM – 12 PM)', 'Afternoon (12 PM – 5 PM)', 'Evening (5 PM – 9 PM)', "I'm flexible"];
  function choices(values, target, type, name) {
    values.forEach((value, index) => {
      const label = document.createElement('label');
      label.className = 'private-booking__choice';
      const input = document.createElement('input');
      input.type = type;
      input.name = name;
      input.value = value;
      if (name === 'time' && index === 3) input.checked = true;
      if (name === 'days') input.setAttribute('aria-describedby', 'booking-days-error');
      const text = document.createElement('span');
      text.textContent = value;
      label.append(input, text);
      panel.querySelector(target).append(label);
    });
  }
  choices(days, '.private-booking__days', 'checkbox', 'days');
  choices(times, '.private-booking__times', 'radio', 'time');
  let activeCard;
  let activeButton;
  cards[0].parentElement.after(panel);
  let scrollTimer;
  function closePanel() {
    clearTimeout(scrollTimer);
    panel.classList.remove('is-open');
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    activeCard?.classList.remove('is-selected');
    activeButton?.setAttribute('aria-expanded', 'false');
  }
  cards.forEach((card) => {
    const link = card.querySelector('a.button');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = link.className;
    button.textContent = link.textContent;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', panel.id);
    link.replaceWith(button);
    button.addEventListener('click', () => {
      if (activeCard === card && panel.classList.contains('is-open')) {
        closePanel();
        return;
      }
      activeCard?.classList.remove('is-selected');
      activeButton?.setAttribute('aria-expanded', 'false');
      activeCard = card;
      activeButton = button;
      card.classList.add('is-selected');
      button.setAttribute('aria-expanded', 'true');
      panel.querySelector('.private-booking__package').textContent = `${card.querySelector('h3').textContent} — ${card.querySelector('.package-card__price').textContent.trim()}`;
      panel.hidden = false;
      panel.inert = false;
      panel.removeAttribute('aria-hidden');
      // Resolve the collapsed height before starting the expansion.
      panel.getBoundingClientRect();
      panel.classList.add('is-open');
      panel.querySelector('h2').focus({ preventScroll: true });
      clearTimeout(scrollTimer);
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scrollTimer = setTimeout(() => {
        const bounds = panel.getBoundingClientRect();
        if (bounds.top < 90 || bounds.bottom > window.innerHeight) {
          panel.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
        }
      }, reducedMotion ? 0 : 260);
    });
  });
  form.addEventListener('change', () => { panel.querySelector('.private-booking__error').textContent = ''; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selectedDays = [...form.querySelectorAll('input[name="days"]:checked')].map((input) => input.value);
    if (!selectedDays.length) {
      panel.querySelector('.private-booking__error').textContent = 'Please select at least one preferred day.';
      form.querySelector('input[name="days"]').focus();
      return;
    }
    const preferences = {
      package: activeCard.querySelector('h3').textContent,
      price: activeCard.querySelector('.package-card__price').textContent.trim(),
      days: selectedDays,
      time: form.querySelector('input[name="time"]:checked').value,
      notes: panel.querySelector('textarea').value.trim()
    };
    try {
      sessionStorage.setItem('pure-private-booking', JSON.stringify(preferences));
    } catch {
      panel.querySelector('.private-booking__storage-error').textContent = 'Your browser could not save your preferences. Please enable session storage and try again.';
      return;
    }
    window.location.assign('get-started.html?support=private&intent=enquiry');
  });
})();
