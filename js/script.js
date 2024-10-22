fetch('./js/swiper-bundle.min.js').then(r => { return r.text() }).then(t => {
  let tag = ['Start', '1', '2', '3', '4', '5', '6', '7', '8', 'おまけ', 'OMAKE'];
  let first = 0;
  const myDelay = 3000;
  // const slideLength = document.querySelectorAll('.flow01 .swiper-slide').length;
  // const total = ('00' + slideLength).slice(-2);

  // const fractionNum = document.querySelector('.flow01 .fraction .num');
  // const fractionTotal = document.querySelector('.flow01 .fraction .total');
  // fractionTotal.textContent = total;

  // const updateFraction = (index) => {
  //   console.log("update");
  //   let current = ('00' + (index + 1)).slice(-2);
  //   fractionNum.classList.add('anm-started');
  //   setTimeout(() => {
  //     fractionNum.textContent = current;
  //   }, 400);
  // }

  const startAnimation = (index) => {
    // console.log("start");
    let activeSlide = document.querySelectorAll('.flow01 .content')[index];
    activeSlide.classList.remove('anm-finished');
    activeSlide.classList.add('anm-started');
  }

  const finishAnimation = () => {
    let activeSlide = document.querySelector('.flow01 .content.anm-started');
    if (activeSlide) {
      // if (first == 1) {
        activeSlide.classList.remove('anm-started');
        activeSlide.classList.add('anm-finished');
        console.log("finish1");
      // } else {
        // first = 1;
        // console.log("finish else");
      // }
    }
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
      // afterInit: (swiper) => {
        //updateFraction(swiper.realIndex);
        //finishAnimation();
        //startAnimation(swiper.realIndex);
        //fractionNum.classList.remove('anm-started');
      // },
      slideChange: (swiper) => {
        // updateFraction(swiper.realIndex);
        finishAnimation();
        console.log(swiper.realIndex);
        if (swiper.realIndex == "0") {
          startAnimation(swiper.realIndex);
          // fractionNum.classList.remove('anm-started');
        };

      const totalSlides = swiper.slides.length - 1; // 全スライド数（インデックスは0始まり）
      const currentSlide = swiper.realIndex; // 現在のスライドのインデックス
 console.log(currentSlide,totalSlides);
      if (currentSlide === totalSlides - 1) { // 最後のスライドに達したか確認
        // 1秒後に画像をスライドインさせる
       
        console.log("INcontinued");
        setTimeout(function () {
          const toBeContinuedImg = document.getElementById('toBeContinuedImg');
          toBeContinuedImg.classList.add('slide-in');
        }, 1000); // 1秒の遅延
      };
      },
      slideChangeTransitionStart: (swiper) => {
        startAnimation(swiper.realIndex);
      },
      slideChangeTransitionEnd: () => {
        // fractionNum.classList.remove('anm-started');
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
