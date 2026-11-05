'use strict';

const DESKTOP_BREAKPOINT = 1024;
const SCROLL_EDGE_TOLERANCE = 1;
const INSTAGRAM_PROFILE_URL = 'https://www.instagram.com/pure_coaching_cairns/';
const LOADER_DELAY = 500;
const LOADER_MIN_VISIBLE_TIME = 300;
const LOADER_TIMEOUT = 20000;
const SHARED_SCRIPT_URL = document.currentScript?.src || new URL('script.js', window.location.href).href;
const BRAND_LOADER_URL = new URL('assets/logo/brand-circle.png', SHARED_SCRIPT_URL).href;

// Temporary local posts. Replace this data source with /api/instagram when available.
const TEMPORARY_INSTAGRAM_POSTS = [
  {
    mediaType: 'IMAGE',
    image: 'assets/images/child-safety/support-everyday-life.webp',
    permalink: INSTAGRAM_PROFILE_URL,
    alt: 'Young person and support worker sharing a high five during an outdoor activity'
  },
  {
    mediaType: 'REEL',
    image: 'assets/images/activities/outdoor-adventure.webp',
    permalink: INSTAGRAM_PROFILE_URL,
    alt: 'Outdoor adventure activity with Pure Coaching support'
  },
  {
    mediaType: 'CAROUSEL',
    image: 'assets/images/activities/fitness-wellbeing.webp',
    permalink: INSTAGRAM_PROFILE_URL,
    alt: 'Fitness and wellbeing activity with Pure Coaching'
  },
  {
    mediaType: 'IMAGE',
    image: 'assets/images/activities/social-activities.webp',
    permalink: INSTAGRAM_PROFILE_URL,
    alt: 'Social and community activity with Pure Coaching support'
  }
];

function validateEmailAddress(email, control) {
  if (control && !control.validity.valid) return false;

  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0]) return false;

  const domainParts = parts[1].split('.');
  return domainParts.length >= 2 && domainParts.every((part) => (
    part.length > 0
    && /^[a-z0-9-]+$/i.test(part)
    && !part.startsWith('-')
    && !part.endsWith('-')
  ));
}

function normaliseAustralianPhone(phone) {
  return phone.replace(/[\s()-]/g, '');
}

function validateAustralianPhone(phone) {
  const normalisedPhone = normaliseAustralianPhone(phone);
  return /^(?:04\d{8}|0[2378]\d{8}|\+614\d{8}|\+61[2378]\d{8})$/.test(normalisedPhone);
}

function initMobileNavigation() {
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const mobileNav = document.querySelector('[data-mobile-nav]');

  if (!menuToggle || !mobileNav) {
    return;
  }

  const closeMenu = (returnFocus = false) => {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation menu');
    mobileNav.hidden = true;

    if (returnFocus) {
      menuToggle.focus();
    }
  };

  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';

    if (isOpen) {
      closeMenu();
      return;
    }

    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', 'Close navigation menu');
    mobileNav.hidden = false;
  });

  mobileNav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !mobileNav.hidden) {
      closeMenu(true);
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth >= DESKTOP_BREAKPOINT && !mobileNav.hidden) {
      closeMenu();
    }
  });
}

function initStickyHeader() {
  const header = document.querySelector('[data-header]');

  if (!header) {
    return;
  }

  const isHomepage = document.body.classList.contains('page-home');
  let revealed = null;

  const updateHeader = () => {
    header.classList.toggle('is-scrolled', window.scrollY > 0);
    if (!isHomepage) return;

    // Separate reveal/hide thresholds avoid flicker from small scroll movements.
    const nextRevealed = window.scrollY > (revealed ? 8 : 48);
    if (nextRevealed === revealed) return;
    revealed = nextRevealed;

    if (!revealed) {
      if (header.contains(document.activeElement)) {
        document.querySelector('.pathway-hero__scroll-cue')?.focus({ preventScroll: true });
      }
      const menuToggle = header.querySelector('[data-menu-toggle]');
      if (menuToggle?.getAttribute('aria-expanded') === 'true') menuToggle.click();
    }
    header.inert = !revealed;
    header.classList.toggle('is-revealed', revealed);
  };

  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();
}

function initCarousel(carousel) {
  const track = carousel.querySelector('[data-carousel-track]');
  const previousButton = carousel.querySelector('[data-carousel-previous]');
  const nextButton = carousel.querySelector('[data-carousel-next]');
  const paginationDots = Array.from(carousel.querySelectorAll('[data-carousel-dot]'));

  if (!track || !previousButton || !nextButton || !track.firstElementChild) {
    return null;
  }

  const updateControls = () => {
    const maximumScroll = track.scrollWidth - track.clientWidth;

    previousButton.disabled = track.scrollLeft <= SCROLL_EDGE_TOLERANCE;
    nextButton.disabled = track.scrollLeft >= maximumScroll - SCROLL_EDGE_TOLERANCE;

    if (paginationDots.length) {
      const progress = maximumScroll > 0 ? track.scrollLeft / maximumScroll : 0;
      const activeIndex = Math.round(progress * (paginationDots.length - 1));

      paginationDots.forEach((dot, index) => {
        if (index === activeIndex) {
          dot.setAttribute('aria-current', 'true');
        } else {
          dot.removeAttribute('aria-current');
        }
      });
    }
  };

  const scrollByItem = (direction) => {
    const trackStyles = window.getComputedStyle(track);
    const gap = Number.parseFloat(trackStyles.columnGap) || 0;
    const itemWidth = track.firstElementChild.getBoundingClientRect().width;

    track.scrollBy({
      left: direction * (itemWidth + gap),
      behavior: 'smooth'
    });
  };

  previousButton.addEventListener('click', () => scrollByItem(-1));
  nextButton.addEventListener('click', () => scrollByItem(1));
  paginationDots.forEach((dot, index) => {
    dot.addEventListener('click', () => {
      const item = track.children[index];

      if (!item) {
        return;
      }

      track.scrollTo({
        left: item.offsetLeft - track.firstElementChild.offsetLeft,
        behavior: 'smooth'
      });
    });
  });
  track.addEventListener('scroll', updateControls, { passive: true });
  updateControls();

  return updateControls;
}

function createInstagramMediaIcon(mediaType) {
  if (mediaType === 'VIDEO' || mediaType === 'REEL') {
    return '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z"></path></svg>';
  }

  if (mediaType === 'CAROUSEL') {
    return '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="7" y="7" width="12" height="12" rx="2"></rect><path d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"></path></svg>';
  }

  return '';
}

function setInstagramFeedState(section, state) {
  const feed = section.querySelector('[data-instagram-feed]');
  section.dataset.feedState = state;
  feed.hidden = state === 'unavailable';
  feed.setAttribute('aria-busy', String(state === 'loading'));
}

function renderInstagramFeed(section, posts) {
  const feed = section.querySelector('[data-instagram-feed]');
  if (!feed) return;

  feed.replaceChildren();
  posts.forEach((post) => {
    const link = document.createElement('a');
    const image = document.createElement('img');
    const mediaIcon = createInstagramMediaIcon(post.mediaType);

    link.className = 'instagram-post';
    link.href = post.permalink;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('role', 'listitem');
    link.setAttribute('aria-label', `${post.alt}. Open on Instagram.`);

    image.src = post.image;
    image.alt = post.alt;
    image.width = 900;
    image.height = 900;
    image.loading = 'lazy';
    image.decoding = 'async';
    link.append(image);

    if (mediaIcon) {
      const indicator = document.createElement('span');
      indicator.className = 'instagram-post__media-type';
      indicator.innerHTML = mediaIcon;
      link.append(indicator);
    }

    feed.append(link);
  });

  setInstagramFeedState(section, posts.length ? 'success' : 'unavailable');
}

function initInstagramFeed() {
  const section = document.querySelector('[data-instagram-section]');
  if (!section) return;

  renderInstagramFeed(section, TEMPORARY_INSTAGRAM_POSTS);
}

function setCurrentYear() {
  const currentYear = document.querySelector('[data-current-year]');

  if (currentYear) {
    currentYear.textContent = new Date().getFullYear();
  }
}

function initModal(modal) {
  const openButtons = Array.from(document.querySelectorAll(`[data-modal-open="${modal.id}"]`));
  const closeButtons = Array.from(modal.querySelectorAll('[data-modal-close]'));
  const dialog = modal.querySelector('[role="dialog"]');
  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let returnFocusTo = null;

  if (!openButtons.length || !dialog) {
    return;
  }

  const closeModal = () => {
    modal.hidden = true;
    document.body.classList.remove('has-modal-open');
    openButtons.forEach((button) => button.setAttribute('aria-expanded', 'false'));
    returnFocusTo?.focus();
    returnFocusTo = null;
  };

  const openModal = (trigger) => {
    returnFocusTo = trigger;
    modal.hidden = false;
    document.body.classList.add('has-modal-open');
    trigger.setAttribute('aria-expanded', 'true');
    modal.querySelector('.modal__close')?.focus();
  };

  openButtons.forEach((button) => button.addEventListener('click', () => openModal(button)));
  closeButtons.forEach((button) => button.addEventListener('click', closeModal));

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusableElements = Array.from(dialog.querySelectorAll(focusableSelector));
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement || !lastElement) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  });
}

function initGallery(gallery) {
  const items = Array.from(gallery.querySelectorAll('[data-gallery-item]'));
  const lightbox = gallery.querySelector('[data-gallery-lightbox]');
  const dialog = lightbox?.querySelector('[role="dialog"]');
  const lightboxImage = lightbox?.querySelector('[data-gallery-lightbox-image]');
  const stage = lightbox?.querySelector('[data-gallery-stage]');
  const previousButton = lightbox?.querySelector('[data-gallery-previous]');
  const nextButton = lightbox?.querySelector('[data-gallery-next]');
  const closeButtons = Array.from(lightbox?.querySelectorAll('[data-gallery-close]') || []);
  const focusableSelector = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
  let currentIndex = 0;
  let returnFocusTo = null;
  let touchStartX = null;

  if (!items.length || !lightbox || !dialog || !lightboxImage || !stage || !previousButton || !nextButton) return;

  items.forEach((item) => {
    item.setAttribute('aria-controls', lightbox.id);
    item.setAttribute('aria-expanded', 'false');
  });

  const showPhoto = (index) => {
    currentIndex = (index + items.length) % items.length;
    const sourceImage = items[currentIndex].querySelector('img');
    if (!sourceImage) return;

    lightboxImage.src = sourceImage.currentSrc || sourceImage.src;
    lightboxImage.alt = sourceImage.alt;
  };

  const closeGallery = () => {
    lightbox.hidden = true;
    document.body.classList.remove('has-modal-open');
    items.forEach((item) => item.setAttribute('aria-expanded', 'false'));
    returnFocusTo?.focus({ preventScroll: true });
    returnFocusTo = null;
  };

  const openGallery = (item, index) => {
    returnFocusTo = item;
    showPhoto(index);
    lightbox.hidden = false;
    document.body.classList.add('has-modal-open');
    item.setAttribute('aria-expanded', 'true');
    lightbox.querySelector('.gallery-lightbox__close')?.focus();
  };

  items.forEach((item, index) => {
    item.addEventListener('click', () => openGallery(item, index));
  });
  closeButtons.forEach((button) => button.addEventListener('click', closeGallery));
  previousButton.addEventListener('click', () => showPhoto(currentIndex - 1));
  nextButton.addEventListener('click', () => showPhoto(currentIndex + 1));

  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGallery();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      showPhoto(currentIndex - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      showPhoto(currentIndex + 1);
      return;
    }
    if (event.key !== 'Tab') return;

    const focusableElements = Array.from(dialog.querySelectorAll(focusableSelector));
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement || !lastElement) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  });

  stage.addEventListener('touchstart', (event) => {
    touchStartX = event.changedTouches[0]?.clientX ?? null;
  }, { passive: true });
  stage.addEventListener('touchend', (event) => {
    if (touchStartX === null) return;
    const touchEndX = event.changedTouches[0]?.clientX ?? touchStartX;
    const distance = touchEndX - touchStartX;
    touchStartX = null;

    if (Math.abs(distance) < 50) return;
    showPhoto(currentIndex + (distance < 0 ? 1 : -1));
  }, { passive: true });
}

function initDisclosure(disclosure) {
  const trigger = disclosure.querySelector('[data-disclosure-trigger]');
  const panel = disclosure.querySelector('[data-disclosure-panel]');
  const closeButton = disclosure.querySelector('[data-disclosure-close]');

  if (!trigger || !panel) return;

  const setOpen = (isOpen) => {
    trigger.setAttribute('aria-expanded', String(isOpen));
    panel.hidden = !isOpen;

    if (isOpen) {
      panel.querySelector('[data-disclosure-heading]')?.focus({ preventScroll: true });
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      trigger.focus();
    }
  };

  trigger.addEventListener('click', () => setOpen(panel.hidden));
  closeButton?.addEventListener('click', () => setOpen(false));
}

function initAccordion(accordion) {
  const items = Array.from(accordion.querySelectorAll('[data-accordion-item]'));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = typeof Element.prototype.animate === 'function';

  if (!items.length) return;

  const getParts = (item) => ({
    trigger: item.querySelector('[data-accordion-trigger]'),
    panel: item.querySelector('[data-accordion-panel]')
  });

  const setOpen = async (item, isOpen, immediate = false) => {
    const { trigger, panel } = getParts(item);
    if (!trigger || !panel) return;

    panel.getAnimations?.().forEach((animation) => animation.cancel());
    trigger.setAttribute('aria-expanded', String(isOpen));

    if (isOpen) {
      panel.hidden = false;
      if (immediate || reduceMotion || !canAnimate) return;

      panel.animate(
        [{ height: '0px', opacity: 0 }, { height: `${panel.scrollHeight}px`, opacity: 1 }],
        { duration: 180, easing: 'ease-out' }
      );
      return;
    }

    if (panel.hidden) return;
    if (immediate || reduceMotion || !canAnimate) {
      panel.hidden = true;
      return;
    }

    const animation = panel.animate(
      [{ height: `${panel.scrollHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
      { duration: 160, easing: 'ease-in' }
    );

    try {
      await animation.finished;
    } catch {
      return;
    }

    if (trigger.getAttribute('aria-expanded') === 'false') panel.hidden = true;
  };

  items.forEach((item) => {
    const { trigger, panel } = getParts(item);
    if (!trigger || !panel) return;

    trigger.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    trigger.addEventListener('click', () => {
      const shouldOpen = trigger.getAttribute('aria-expanded') !== 'true';
      items.forEach((otherItem) => {
        if (otherItem !== item) setOpen(otherItem, false);
      });
      setOpen(item, shouldOpen);
    });
  });

  if (window.matchMedia('(min-width: 768px)').matches) {
    const defaultItem = items.find((item) => item.hasAttribute('data-accordion-default'));
    if (defaultItem) setOpen(defaultItem, true, true);
  }
}

function initInterestForm(form) {
  const status = form.querySelector('[data-interest-status]');
  const confirmation = form.parentElement.querySelector('[data-interest-confirmation]');

  form.querySelectorAll('[data-interest-error]').forEach((error) => {
    const control = form.elements.namedItem(error.dataset.interestError);
    error.id = `interest-${error.dataset.interestError}-error`;
    control?.setAttribute('aria-describedby', error.id);
  });

  const clearError = (control) => {
    const error = form.querySelector(`[data-interest-error="${control.name}"]`);
    if (error) error.textContent = '';
    control.removeAttribute('aria-invalid');
  };

  const setError = (control, message) => {
    const error = form.querySelector(`[data-interest-error="${control.name}"]`);
    if (error) error.textContent = message;
    control.setAttribute('aria-invalid', 'true');
  };

  form.addEventListener('input', (event) => clearError(event.target));
  form.addEventListener('change', (event) => clearError(event.target));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    status.hidden = true;
    form.querySelectorAll('[aria-invalid="true"]').forEach(clearError);
    let firstInvalid = null;

    form.querySelectorAll('input[required]').forEach((control) => {
      let message = '';
      if (!control.validity.valid) message = `Please enter your ${control.labels?.[0]?.textContent.toLowerCase() || 'information'}.`;
      if (control.type === 'email' && !validateEmailAddress(control.value.trim(), control)) message = 'Please enter a valid email address, for example name@example.com.';
      if (control.type === 'tel' && !validateAustralianPhone(control.value.trim())) message = 'Please enter a valid Australian mobile or landline number.';

      if (message) {
        setError(control, message);
        firstInvalid ||= control;
      }
    });

    if (firstInvalid) {
      status.textContent = 'Please check the highlighted information before continuing.';
      status.hidden = false;
      firstInvalid.focus();
      return;
    }

    // Future backend/API and optional resume upload should be connected here.
    form.hidden = true;
    confirmation.hidden = false;
    confirmation.focus();
  });
}

function initPathwayHeroVideos() {
  const pathways = Array.from(document.querySelectorAll('.pathway-hero__panel'), (panel) => ({
    panel,
    video: panel.querySelector('[data-pathway-hero-video]')
  })).filter(({ video }) => video);

  if (!pathways.length) return;

  const hoverPointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activePathway = null;

  const pauseAll = () => {
    activePathway = null;
    pathways.forEach(({ panel, video }) => {
      panel.classList.remove('is-active');
      video.pause();
    });
  };

  const activate = async (pathway) => {
    if (document.hidden || activePathway === pathway) return;

    activePathway = pathway;
    pathways.forEach((item) => {
      item.panel.classList.toggle('is-active', item === pathway);
      if (item !== pathway) item.video.pause();
    });
    if (reducedMotion.matches) return;

    try {
      await pathway.video.play();
      // Playback may finish starting after the pointer/focus has already moved.
      if (activePathway !== pathway || reducedMotion.matches || document.hidden) {
        pathway.video.pause();
      }
    } catch {
      // A blocked or interrupted play attempt must never interfere with the link.
    }
  };

  const deactivate = (pathway) => {
    if (activePathway === pathway) activePathway = null;
    pathway.panel.classList.remove('is-active');
    pathway.video.pause();
  };

  // Transfer the shared active state directly to the next pathway link.
  const leave = (pathway, nextTarget, keyboard = false) => {
    const next = pathways.find(({ panel }) => panel.contains(nextTarget));
    if (next && (!keyboard || next.panel.matches(':focus-visible'))) {
      activate(next);
    } else {
      deactivate(pathway);
    }
  };

  pathways.forEach((pathway) => {
    const { panel, video } = pathway;
    video.muted = true;
    video.pause();
    video.currentTime = 0;

    video.addEventListener('ended', () => {
      // Only natural completion rewinds; hover/focus changes retain the frame.
      video.pause();
      video.currentTime = 0;
    });

    panel.addEventListener('pointerenter', (event) => {
      if (hoverPointer.matches && event.pointerType !== 'touch') activate(pathway);
    });
    panel.addEventListener('pointerleave', (event) => {
      if (hoverPointer.matches && event.pointerType !== 'touch') leave(pathway, event.relatedTarget);
    });
    panel.addEventListener('focus', () => {
      // Keyboard focus also works with an attached keyboard on a touch device.
      // Pointer/tap focus must not turn navigation into a playback interaction.
      if (panel.matches(':focus-visible')) activate(pathway);
    });
    panel.addEventListener('blur', (event) => leave(pathway, event.relatedTarget, true));
  });

  reducedMotion.addEventListener('change', pauseAll);
  hoverPointer.addEventListener('change', pauseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAll();
  });
  window.addEventListener('pagehide', pauseAll);
}

function initEmploymentJourney(journey) {
  const wheel = journey.querySelector('[data-employment-wheel]');
  const stages = Array.from(journey.querySelectorAll('[data-employment-stage]'));
  const detailNumber = journey.querySelector('[data-employment-detail-number]');
  const detailTitle = journey.querySelector('[data-employment-detail-title]');
  const detailPhrase = journey.querySelector('[data-employment-detail-phrase]');
  const detailDescription = journey.querySelector('[data-employment-detail-description]');
  const detailPoints = journey.querySelector('[data-employment-detail-points]');
  const previousButton = journey.querySelector('[data-employment-previous]');
  const nextButton = journey.querySelector('[data-employment-next]');

  if (!wheel || !stages.length || !detailNumber || !detailTitle || !detailPhrase || !detailDescription || !detailPoints) return;

  const angleStep = 360 / stages.length;
  let currentIndex = 0;
  let currentRotation = 0;

  const shortestAngle = (angle) => ((angle + 540) % 360) - 180;

  const updateDetails = (stage) => {
    detailNumber.textContent = stage.dataset.number;
    detailTitle.textContent = stage.dataset.title;
    detailPhrase.textContent = stage.dataset.phrase;
    detailDescription.textContent = stage.dataset.description;
    detailPoints.replaceChildren(...stage.dataset.points.split('|').map((point) => {
      const item = document.createElement('li');
      item.textContent = point;
      return item;
    }));
  };

  const selectStage = (index) => {
    const nextIndex = (index + stages.length) % stages.length;
    const targetRotation = -nextIndex * angleStep;
    const delta = shortestAngle(targetRotation - (currentRotation % 360));

    currentRotation += delta;
    currentIndex = nextIndex;
    wheel.style.setProperty('--journey-rotation', `${currentRotation}deg`);
    wheel.style.setProperty('--journey-counter-rotation', `${-currentRotation}deg`);

    stages.forEach((stage, stageIndex) => {
      const isActive = stageIndex === currentIndex;
      stage.classList.toggle('is-active', isActive);
      stage.setAttribute('aria-pressed', String(isActive));
    });

    updateDetails(stages[currentIndex]);
  };

  stages.forEach((stage, index) => stage.addEventListener('click', () => selectStage(index)));
  previousButton?.addEventListener('click', () => selectStage(currentIndex - 1));
  nextButton?.addEventListener('click', () => selectStage(currentIndex + 1));
}

function initAmbientVideo(video) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const updatePlayback = async () => {
    if (reducedMotion.matches || document.hidden) {
      video.pause();
      return;
    }

    try {
      await video.play();
    } catch {
      // The media container's clean background remains visible when playback is unavailable.
    }
  };

  reducedMotion.addEventListener('change', updatePlayback);
  document.addEventListener('visibilitychange', updatePlayback);
  updatePlayback();
}

function initLoginForm(form) {
  const passwordInput = form.querySelector('[data-password-input]');
  const passwordToggle = form.querySelector('[data-password-toggle]');

  if (passwordInput && passwordToggle) {
    passwordToggle.addEventListener('click', () => {
      const isVisible = passwordInput.type === 'text';

      passwordInput.type = isVisible ? 'password' : 'text';
      passwordToggle.setAttribute('aria-pressed', String(!isVisible));
      passwordToggle.setAttribute('aria-label', isVisible ? 'Show password' : 'Hide password');
    });
  }

  // Authentication will be connected later; keep this frontend form on-page for now.
  form.addEventListener('submit', (event) => event.preventDefault());
}

function createLoadingIndicator(accessible = false) {
  const indicator = document.createElement('span');
  const image = document.createElement('img');

  indicator.className = 'loading-indicator';
  image.className = 'loading-indicator__image';
  image.src = BRAND_LOADER_URL;
  image.alt = '';
  image.width = 48;
  image.height = 45;
  image.setAttribute('aria-hidden', 'true');
  indicator.append(image);

  if (accessible) {
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-label', 'Loading');
  } else {
    indicator.setAttribute('aria-hidden', 'true');
  }

  return indicator;
}

function initPageLoadingIndicator() {
  const overlay = document.createElement('div');
  const indicator = createLoadingIndicator(true);
  let showTimer;
  let hideTimer;
  let safetyTimer;
  let visibleAt = 0;

  overlay.className = 'page-loading-indicator';
  overlay.hidden = true;
  overlay.append(indicator);
  document.body.append(overlay);

  const finishHiding = () => {
    window.clearTimeout(hideTimer);
    hideTimer = 0;
    visibleAt = 0;
    overlay.hidden = true;
  };

  const hide = (immediately = false) => {
    window.clearTimeout(showTimer);
    window.clearTimeout(safetyTimer);
    showTimer = 0;
    safetyTimer = 0;

    if (overlay.hidden || immediately) {
      finishHiding();
      return;
    }

    const remainingVisibleTime = LOADER_MIN_VISIBLE_TIME - (performance.now() - visibleAt);
    if (remainingVisibleTime > 0) {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(finishHiding, remainingVisibleTime);
      return;
    }

    finishHiding();
  };

  const showAfterDelay = () => {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    window.clearTimeout(safetyTimer);
    hideTimer = 0;

    if (!overlay.hidden) {
      safetyTimer = window.setTimeout(() => hide(true), LOADER_TIMEOUT);
      return;
    }

    showTimer = window.setTimeout(() => {
      showTimer = 0;
      visibleAt = performance.now();
      overlay.hidden = false;
      safetyTimer = window.setTimeout(() => hide(true), LOADER_TIMEOUT);
    }, LOADER_DELAY);
  };

  if (document.readyState === 'loading') {
    showAfterDelay();
    document.addEventListener('DOMContentLoaded', () => hide(), { once: true });
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');

    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return;

    const destination = new URL(link.href, window.location.href);
    const isWebNavigation = destination.protocol === 'http:' || destination.protocol === 'https:' || destination.protocol === 'file:';
    const isSameDocument = destination.pathname === window.location.pathname
      && destination.search === window.location.search
      && destination.hash;

    if (!isWebNavigation || isSameDocument) return;
    showAfterDelay();
  });

  window.addEventListener('pageshow', () => hide(true));
  window.addEventListener('pagehide', () => hide(true));
}

function initMediaLoadingIndicators() {
  const hostStates = new WeakMap();

  const getHostState = (media) => {
    const host = media.parentElement;
    if (!host) return null;

    let state = hostStates.get(host);
    if (state) return state;

    state = {
      host,
      indicator: null,
      pending: new Set(),
      showTimer: 0,
      hideTimer: 0,
      visibleAt: 0,
      safetyTimer: 0
    };
    hostStates.set(host, state);
    return state;
  };

  const finishHidingHostIndicator = (state) => {
    window.clearTimeout(state.hideTimer);
    state.hideTimer = 0;
    state.visibleAt = 0;
    state.indicator?.remove();
    state.indicator = null;
    state.host.classList.remove('media-loading-host');
    state.host.classList.remove('media-loading-host--positioned');
  };

  const hideHostIndicator = (state, immediately = false) => {
    window.clearTimeout(state.showTimer);
    window.clearTimeout(state.safetyTimer);
    state.showTimer = 0;
    state.safetyTimer = 0;

    if (!state.indicator || immediately) {
      finishHidingHostIndicator(state);
      return;
    }

    const remainingVisibleTime = LOADER_MIN_VISIBLE_TIME - (performance.now() - state.visibleAt);
    if (remainingVisibleTime > 0) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = window.setTimeout(() => finishHidingHostIndicator(state), remainingVisibleTime);
      return;
    }

    finishHidingHostIndicator(state);
  };

  const finishLoading = (media) => {
    const state = getHostState(media);
    if (!state) return;

    state.pending.delete(media);
    if (!state.pending.size) hideHostIndicator(state);
  };

  const beginLoading = (media) => {
    const state = getHostState(media);
    if (!state || state.pending.has(media)) return;

    state.pending.add(media);
    if (state.indicator) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = 0;
      return;
    }
    if (state.showTimer) return;

    state.showTimer = window.setTimeout(() => {
      state.showTimer = 0;
      if (!state.pending.size || !state.host.isConnected) return;

      state.host.classList.add('media-loading-host');
      if (window.getComputedStyle(state.host).position === 'static') {
        state.host.classList.add('media-loading-host--positioned');
      }
      state.indicator = createLoadingIndicator();
      state.indicator.classList.add('loading-indicator--media');
      state.host.append(state.indicator);
      state.visibleAt = performance.now();
      state.safetyTimer = window.setTimeout(() => {
        state.pending.clear();
        hideHostIndicator(state, true);
      }, LOADER_TIMEOUT);
    }, LOADER_DELAY);
  };

  const shouldSkipImage = (image) => image.matches('.loading-indicator__image, .brand-watermark')
    || Boolean(image.closest('.site-logo, .site-footer__logo'))
    || image.getAttribute('aria-hidden') === 'true';

  const observeImage = (image) => {
    if (image.dataset.loaderTracked || shouldSkipImage(image)) return;
    image.dataset.loaderTracked = 'true';

    if (image.complete) return;

    beginLoading(image);
    image.addEventListener('load', () => finishLoading(image), { once: true });
    image.addEventListener('error', () => finishLoading(image), { once: true });
  };

  const lazyImageObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        observeImage(entry.target);
      });
    }, { rootMargin: '200px' })
    : null;

  const registerImage = (image) => {
    if (image.dataset.loaderTracked || shouldSkipImage(image) || image.complete) return;
    if (image.loading === 'lazy' && lazyImageObserver) {
      lazyImageObserver.observe(image);
      return;
    }
    observeImage(image);
  };

  const registerVideo = (video) => {
    if (video.dataset.loaderTracked) return;
    video.dataset.loaderTracked = 'true';

    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) beginLoading(video);

    video.addEventListener('loadstart', () => beginLoading(video));
    video.addEventListener('waiting', () => {
      if (!video.paused && !video.ended) beginLoading(video);
    });
    video.addEventListener('stalled', () => {
      if (!video.paused && !video.ended) beginLoading(video);
    });
    video.addEventListener('canplay', () => finishLoading(video));
    video.addEventListener('playing', () => finishLoading(video));
    video.addEventListener('pause', () => finishLoading(video));
    video.addEventListener('ended', () => finishLoading(video));
    video.addEventListener('error', () => finishLoading(video));
  };

  const registerMedia = (root) => {
    if (root instanceof HTMLImageElement) registerImage(root);
    if (root instanceof HTMLVideoElement) registerVideo(root);
    root.querySelectorAll?.('img').forEach(registerImage);
    root.querySelectorAll?.('video').forEach(registerVideo);
  };

  registerMedia(document);

  const mediaObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) registerMedia(node);
      });
    });
  });
  mediaObserver.observe(document.body, { childList: true, subtree: true });
}

function init() {
  initPageLoadingIndicator();
  initMediaLoadingIndicators();
  initMobileNavigation();
  initStickyHeader();
  initPathwayHeroVideos();
  initInstagramFeed();

  const carouselUpdates = Array.from(
    document.querySelectorAll('[data-carousel]'),
    initCarousel
  ).filter(Boolean);

  if (carouselUpdates.length) {
    window.addEventListener('resize', () => {
      carouselUpdates.forEach((updateControls) => updateControls());
    });
  }

  document.querySelectorAll('[data-modal]').forEach(initModal);
  document.querySelectorAll('[data-gallery]').forEach(initGallery);
  document.querySelectorAll('[data-disclosure]').forEach(initDisclosure);
  document.querySelectorAll('[data-accordion]').forEach(initAccordion);
  document.querySelectorAll('[data-interest-form]').forEach(initInterestForm);
  document.querySelectorAll('[data-employment-journey]').forEach(initEmploymentJourney);
  document.querySelectorAll('[data-ambient-video]').forEach(initAmbientVideo);
  document.querySelectorAll('[data-login-form]').forEach(initLoginForm);

  setCurrentYear();
}

init();
