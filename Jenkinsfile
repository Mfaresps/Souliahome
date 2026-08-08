pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '15'))
  }

  stages {
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
        sh 'docker build --build-arg BUILD_NUMBER=${BUILD_NUMBER} -t soulia-frontend:ci-${BUILD_NUMBER} frontend'
      }
    }

    stage('Deploy') {
      when { branch 'main' }
      steps {
        // Update only app containers; --no-deps keeps soulia-mongodb (the live DB) untouched.
        // BUILD_NUMBER is consumed by frontend's build args (see docker-compose.yml) and
        // becomes /version.json inside the image — the deploy marker clients poll.
        sh 'BUILD_NUMBER=${BUILD_NUMBER} docker compose -p soulia up -d --build --no-deps backend frontend'
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
        // السؤال الخطأ. رد 401 على بيانات وهمية دليلٌ على صحة المسار كاملاً
        // (Nest + Mongo + المصادقة)، أما رفض الاتصال فليس كذلك.
        sh '''
          for i in $(seq 1 60); do
            frontend_ok=false
            curl -sf -o /dev/null http://localhost:8080/ && frontend_ok=true
            api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
              -X POST http://localhost:8080/api/auth/login \
              -H 'Content-Type: application/json' \
              -d '{"username":"__healthcheck__","password":"__healthcheck__"}' 2>/dev/null || echo 000)
            backend_state=$(docker inspect -f '{{.State.Status}}' soulia-backend 2>/dev/null || echo missing)
            # أي رد HTTP حقيقي (401 المتوقع، أو 400/429) يعني أن الـ API حيّ ويوجّه.
            # 000 = لا اتصال، و 502 = nginx وجد الباك-إند ميتاً.
            if [ "$frontend_ok" = true ] && [ "$api_code" != "000" ] && [ "$api_code" != "502" ] && [ "$api_code" != "504" ]; then
              echo "SOULIA deployed and healthy (login endpoint responded $api_code)"
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
  }

  post {
    always {
      sh 'docker rmi soulia-backend:ci-${BUILD_NUMBER} soulia-frontend:ci-${BUILD_NUMBER} 2>/dev/null || true'
    }
  }
}
