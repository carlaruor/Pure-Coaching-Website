'use strict';

const DESKTOP_BREAKPOINT = 1024;
const SCROLL_EDGE_TOLERANCE = 1;

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

  const updateHeader = () => {
    header.classList.toggle('is-scrolled', window.scrollY > 0);
  };

  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();
}

function initCarousel(carousel) {
  const track = carousel.querySelector('[data-carousel-track]');
  const previousButton = carousel.querySelector('[data-carousel-previous]');
  const nextButton = carousel.querySelector('[data-carousel-next]');

  if (!track || !previousButton || !nextButton || !track.firstElementChild) {
    return null;
  }

  const updateControls = () => {
    const maximumScroll = track.scrollWidth - track.clientWidth;

    previousButton.disabled = track.scrollLeft <= SCROLL_EDGE_TOLERANCE;
    nextButton.disabled = track.scrollLeft >= maximumScroll - SCROLL_EDGE_TOLERANCE;
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
  track.addEventListener('scroll', updateControls, { passive: true });
  updateControls();

  return updateControls;
}

function setCurrentYear() {
  const currentYear = document.querySelector('[data-current-year]');

  if (currentYear) {
    currentYear.textContent = new Date().getFullYear();
  }
}

function init() {
  initMobileNavigation();
  initStickyHeader();

  const carouselUpdates = Array.from(
    document.querySelectorAll('[data-carousel]'),
    initCarousel
  ).filter(Boolean);

  if (carouselUpdates.length) {
    window.addEventListener('resize', () => {
      carouselUpdates.forEach((updateControls) => updateControls());
    });
  }

  setCurrentYear();
}

init();
