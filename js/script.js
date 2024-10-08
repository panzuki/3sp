fetch('./js/swiper-bundle.min.js').then(r => { return r.text() }).then(t => {
  let tag = ['Start', '14,400 years ago', '6,000 B.C.E', '4,000 B.C.E', 'd'];
  const first = 0;
  const myDelay = 3000;
  const slideLength = document.querySelectorAll('.flow01 .swiper-slide').length;
  const total = ('00' + slideLength).slice(-2);

  const fractionNum = document.querySelector('.flow01 .fraction .num');
  const fractionTotal = document.querySelector('.flow01 .fraction .total');
  fractionTotal.textContent = total;

  const updateFraction = (index) => {
    alert("update");
    let current = ('00' + (index + 1)).slice(-2);
    fractionNum.classList.add('anm-started');
    setTimeout(() => {
      fractionNum.textContent = current;
    }, 400);
  }

  const startAnimation = (index) => {
    alert("start");
    let activeSlide = document.querySelectorAll('.flow01 .content')[index];
    activeSlide.classList.remove('anm-finished');
    activeSlide.classList.add('anm-started');
  }
  
  const finishAnimation = () => {
    alert(first);
    let activeSlide = document.querySelector('.flow01 .content.anm-started');
    if (activeSlide) {
      if(first === 0){
      activeSlide.classList.remove('anm-started');
      activeSlide.classList.add('anm-finished');
      }else{
        first = 1;
      }
    }
    alert(first);
  }

  const mySwiper_main = new Swiper('.flow01 .swiper-main', {
    loop: true,
    loopAdditionalSlides: 1,
    spaceBetween: 0,
    speed: 3000,
    delay: myDelay,
    disableOnInteraction: false,
    waitForTransition: false,
    followFinger: false,
    observeParents: true,

    on: {
      afterInit: (swiper) =>{
        startAnimation(swiper.realIndex);
        updateFraction(swiper.realIndex);
      },
      slideChange: (swiper) => {
         updateFraction(swiper.realIndex);
         finishAnimation();
       },
      slideChangeTransitionStart: (swiper) => {
        startAnimation(swiper.realIndex);
      },
      slideChangeTransitionEnd: () => {
        fractionNum.classList.remove('anm-started');
      },
    },
    centeredSlides: true,
    grabCursor: true,
    pagination: {
      el: '.flow01 .swiper-pagination-main',
      clickable: true,
      renderBullet: (index, className) => {
        let num = ('00' + (index + 1)).slice(-2);
        return '<span class="' + className + '"><span class="step"></span>' + tag[index] + '</span>';
      },
    },
    breakpoints: {
      1025: {
        spaceBetween: 0,
      }
    },
    keyboard: {
      enabled: true,
      onlyInViewport: false,
    },
  });
});
