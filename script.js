'use strict';

const header = document.querySelector('[data-header]');
const menuToggle = document.querySelector('[data-menu-toggle]');
const mobileNav = document.querySelector('[data-mobile-nav]');

const closeMenu = () => {
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open navigation menu');
  mobileNav.hidden = true;
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
    closeMenu();
    menuToggle.focus();
  }
});

window.addEventListener(
  'scroll',
  () => header.classList.toggle('is-scrolled', window.scrollY > 0),
  { passive: true }
);

window.addEventListener('resize', () => {
  if (window.innerWidth >= 1024 && !mobileNav.hidden) {
    closeMenu();
  }
});

const activitiesCarousel = document.querySelector('[data-activities-carousel]');
const previousActivityButton = document.querySelector('[data-carousel-previous]');
const nextActivityButton = document.querySelector('[data-carousel-next]');

if (activitiesCarousel && previousActivityButton && nextActivityButton) {
  const updateCarouselControls = () => {
    const maximumScroll = activitiesCarousel.scrollWidth - activitiesCarousel.clientWidth;

    previousActivityButton.disabled = activitiesCarousel.scrollLeft <= 1;
    nextActivityButton.disabled = activitiesCarousel.scrollLeft >= maximumScroll - 1;
  };

  const scrollCarousel = (direction) => {
    const firstCard = activitiesCarousel.querySelector('.activity-card');
    const carouselStyles = window.getComputedStyle(activitiesCarousel);
    const gap = Number.parseFloat(carouselStyles.columnGap) || 0;
    const distance = firstCard.getBoundingClientRect().width + gap;

    activitiesCarousel.scrollBy({
      left: direction * distance,
      behavior: 'smooth'
    });
  };

  previousActivityButton.addEventListener('click', () => scrollCarousel(-1));
  nextActivityButton.addEventListener('click', () => scrollCarousel(1));
  activitiesCarousel.addEventListener('scroll', updateCarouselControls, { passive: true });
  window.addEventListener('resize', updateCarouselControls);

  updateCarouselControls();
}

const reviewsCarousel = document.querySelector('[data-reviews-carousel]');
const previousReviewButton = document.querySelector('[data-reviews-previous]');
const nextReviewButton = document.querySelector('[data-reviews-next]');

if (reviewsCarousel && previousReviewButton && nextReviewButton) {
  const updateReviewControls = () => {
    const maximumScroll = reviewsCarousel.scrollWidth - reviewsCarousel.clientWidth;

    previousReviewButton.disabled = reviewsCarousel.scrollLeft <= 1;
    nextReviewButton.disabled = reviewsCarousel.scrollLeft >= maximumScroll - 1;
  };

  const scrollReviews = (direction) => {
    const firstReview = reviewsCarousel.querySelector('.review-card');
    const carouselStyles = window.getComputedStyle(reviewsCarousel);
    const gap = Number.parseFloat(carouselStyles.columnGap) || 0;
    const distance = firstReview.getBoundingClientRect().width + gap;

    reviewsCarousel.scrollBy({
      left: direction * distance,
      behavior: 'smooth'
    });
  };

  previousReviewButton.addEventListener('click', () => scrollReviews(-1));
  nextReviewButton.addEventListener('click', () => scrollReviews(1));
  reviewsCarousel.addEventListener('scroll', updateReviewControls, { passive: true });
  window.addEventListener('resize', updateReviewControls);

  updateReviewControls();
}

const currentYear = document.querySelector('[data-current-year]');

if (currentYear) {
  currentYear.textContent = new Date().getFullYear();
}
