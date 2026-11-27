pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '15'))
  }

  stages {
    stage('Shopify deployment config') {
      when { branch 'main' }
      steps {
        // Validate Compose before building or replacing live containers. Shopify
        // credentials can also be saved in the application Settings; --quiet
        // never prints resolved environment credentials.
        sh 'docker compose -p soulia config --quiet'
      }
    }
    // فحص مبكر يطبع — في أول أسطر الـ console — سبب أشهر نوعين من الفشل البيئي:
    // امتلاء القرص، وانقطاع الوصول لسجل npm. #74/#75 فشلا على كود سبق نجاحه (#71
    // على نفس revision #74)، فالسبب بيئي بالضرورة — هذه المرحلة تجعله مقروءاً
    // بدل التخمين. لا تُفشِل البناء بنفسها؛ تقرير فقط.
    stage('Env sanity') {
      steps {
        sh '''
          echo "=== disk ==="
          df -h / || true
          echo "=== docker disk ==="
          docker system df || true
          echo "=== npm registry ==="
          if curl -sf -o /dev/null --max-time 10 https://registry.npmjs.org/; then
            echo "npm registry OK"
          else
            echo "WARNING: npm registry UNREACHABLE — docker build (npm install) will likely fail"
          fi
        '''
      }
    }

    stage('Build images') {
      steps {
        sh 'docker build -t soulia-backend:ci-${BUILD_NUMBER} backend'
        // BUILD_NUMBER is baked into the frontend image as /version.json — this is what
        // signals connected clients to force-refresh, so it must be passed on every build.
        sh 'docker build --build-arg BUILD_NUMBER=${BUILD_NUMBER} --build-arg GIT_COMMIT=${GIT_COMMIT} -t soulia-frontend:ci-${BUILD_NUMBER} frontend'
      }
    }

    stage('Inventory readiness before deployment') {
      when { branch 'main' }
      steps {
        // Run the new image against the configured DB with read-only inspection.
        // A failed gate leaves the existing live backend/frontend containers running.
        sh 'docker compose -p soulia build backend'
        sh 'docker compose -p soulia run --rm --no-deps backend node scripts/check-inventory-readiness.cjs'
      }
    }

    stage('Deploy') {
      when { branch 'main' }
      steps {
        // Update only app containers; --no-deps keeps soulia-mongodb (the live DB) untouched.
        // BUILD_NUMBER is consumed by frontend's build args (see docker-compose.yml) and
        // becomes /version.json inside the image — the deploy marker clients poll.
        //
        // «مزامنة من النسخة الحية»: مفتاح التصدير يُحفظ في Jenkins ← Credentials كـ
        // Secret text بالمعرّف soulia-live-sync-token، ويُمرَّر هنا كمتغير بيئة يقرأه
        // docker-compose (LIVE_SYNC_EXPORT_TOKEN). غياب المفتاح لا يُفشل النشر — يبقى
        // التصدير مغلقاً (404) كما كان.
        //
        // «المساعد الخارجي»: بريد الإرسال يُحفظ في Jenkins ← Credentials كـ «Username with password»
        // بالمعرّف soulia-smtp (اسم المستخدم = إيميل الإرسال، كلمة المرور = Gmail App Password)،
        // ويُمرَّر كـ SMTP_USER/SMTP_PASS. غيابه لا يُفشل النشر — تبقى الأسئلة «في انتظار الرد».
        // ⚠ نفس الحساب يرسل رموز الأمان (رمز الدخول من جهاز جديد، استعادة كلمة المرور، تأكيد بريد
        // التحقق — backend/src/auth/security-mailer.service.ts). بدونه تختفي طريقة «البريد» من شاشة التحقق.
        script {
          def deployCmd = 'BUILD_NUMBER=${BUILD_NUMBER} GIT_COMMIT=${GIT_COMMIT} docker compose -p soulia up -d --build --no-deps backend frontend'
          def binds = []
          try {
            withCredentials([string(credentialsId: 'soulia-live-sync-token', variable: 'SYNC_KEY_PROBE')]) { }
            binds << string(credentialsId: 'soulia-live-sync-token', variable: 'LIVE_SYNC_EXPORT_TOKEN')
          } catch (e) {
            echo 'Live sync export key (soulia-live-sync-token) not set in Jenkins — export stays off.'
          }
          try {
            withCredentials([usernamePassword(credentialsId: 'soulia-smtp', usernameVariable: 'SMTP_USER_PROBE', passwordVariable: 'SMTP_PASS_PROBE')]) { }
            binds << usernamePassword(credentialsId: 'soulia-smtp', usernameVariable: 'SMTP_USER', passwordVariable: 'SMTP_PASS')
          } catch (e) {
            echo 'SMTP account (soulia-smtp) not set in Jenkins — external assistant emails stay queued.'
          }
          // «لست برنامجًا آليًا» بـ Cloudflare Turnstile: الاعتماد soulia-turnstile («Username with password»:
          // اسم المستخدم = Site Key، كلمة المرور = Secret Key). غيابه يُبقي التحقق الحسابي الحالي.
          try {
            withCredentials([usernamePassword(credentialsId: 'soulia-turnstile', usernameVariable: 'TS_SITE_PROBE', passwordVariable: 'TS_SECRET_PROBE')]) { }
            binds << usernamePassword(credentialsId: 'soulia-turnstile', usernameVariable: 'TURNSTILE_SITE_KEY', passwordVariable: 'TURNSTILE_SECRET_KEY')
          } catch (e) {
            echo 'Turnstile keys (soulia-turnstile) not set in Jenkins — the built-in robot check stays.'
          }
          withCredentials(binds) {
            sh deployCmd
          }
        }
      }
    }

    stage('Health check') {
      when { branch 'main' }
      steps {
        // 60 محاولة × 2ث = 120ث. النافذة القديمة (60ث) كانت أضيق من إقلاع بارد
        // لـ NestJS + اتصال Mongo على جهاز مضغوط — فكانت تحسب النشرَ فاشلاً
        // والحاويات على وشك الجاهزية.
        //
        // ⚠ الفحص يضرب /api/ فعلياً ولا يكتفي بحالة الحاوية. `restart: unless-stopped`
        // يعيد تشغيل الحاوية بعد كل انهيار، فـ `.State.Status` يقرأ "running" حتى
        // بينما NestJS يموت ويعود في حلقة. هكذا نجح بناءٌ كامل بينما كان الـ API
        // ميتاً ورسالة «خطأ في الطلب» تظهر عند تسجيل الدخول: كان الفحص يسأل
        // السؤال الخطأ. /api/health يختبر Nest واتصال Mongo عبر البروكسي.
        // الفحص لا يسجل محاولة دخول وهمية ولا يرسل إشعار أمان عند كل رفع.
        // Inline Jenkins jobs must use this readiness probe too; authentication
        // requests correctly generate security alerts and are not readiness checks.
        sh '''
          for i in $(seq 1 60); do
            frontend_ok=false
            curl -sf -o /dev/null http://localhost:8080/ && frontend_ok=true
            api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
              http://localhost:8080/api/health 2>/dev/null || echo 000)
            backend_state=$(docker inspect -f '{{.State.Status}}' soulia-backend 2>/dev/null || echo missing)
            # 200 وحده يثبت جاهزية الـ API وقاعدة البيانات.
            # أخطاء الاتصال أو الخادم لا تُحسب نجاحًا ولا تُرسل إعلان نسخة جديدة.
            if [ "$frontend_ok" = true ] && [ "$api_code" = "200" ]; then
              docker exec soulia-backend node scripts/check-shopify-webhook.cjs || exit 1
              echo "SOULIA deployed and healthy (readiness endpoint responded $api_code)"
              exit 0
            fi
            sleep 2
          done
          # عند الفشل: اطبع كل ما يلزم للتشخيص من صفحة الـ build مباشرة —
          # حالة الحاويات، لوج الاثنين (فشل nginx في الإقلاع كان أعمى تماماً
          # قبل ذلك: القديم كان يطبع لوج الباك-إند فقط)، والقرص.
          echo "HEALTH CHECK FAILED (frontend_ok=$frontend_ok api_code=$api_code backend=$backend_state)"
          # عدد مرات إعادة التشغيل يفضح انهيارَ إقلاعٍ متكرراً: حاوية "running"
          # بعدّاد مرتفع هنا لم تُقلع قط، بل تُبعث كل بضع ثوانٍ.
          echo "=== backend restarts ==="
          docker inspect -f '{{.RestartCount}} restarts' soulia-backend || true
          echo "=== containers ==="
          docker compose -p soulia ps || true
          echo "=== backend logs ==="
          docker logs --tail 80 soulia-backend || true
          echo "=== frontend logs ==="
          docker logs --tail 40 soulia-frontend || true
          echo "=== disk ==="
          df -h / || true
          exit 1
        '''
      }
    }
    stage('Notify live release') {
      when { branch 'main' }
      steps {
        // Runs only after Deploy and Health check succeeded. The helper verifies that
        // frontend/version.json matches this build, then records one event per account.
        sh 'docker exec soulia-backend node scripts/notify-release.cjs ${BUILD_NUMBER}'
      }
    }
  }

  post {
    always {
      sh 'docker rmi soulia-backend:ci-${BUILD_NUMBER} soulia-frontend:ci-${BUILD_NUMBER} 2>/dev/null || true'
    }
  }
}
