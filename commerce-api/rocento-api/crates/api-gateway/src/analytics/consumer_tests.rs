use super::*;

#[tokio::test]
#[ignore = "requires a disposable loopback NATS server via NATS_TEST_URL"]
async fn production_batch_waits_for_staggered_arrivals_and_bounds_idle_and_size() {
    let url = std::env::var("NATS_TEST_URL").expect("NATS_TEST_URL");
    let js = async_nats::jetstream::new(async_nats::connect(url).await.unwrap());
    let name = format!("ANALYTICS_BATCH_TEST_{}", Uuid::new_v4().simple());
    let subject = format!("test.{}", Uuid::new_v4().simple());
    let stream = js
        .create_stream(async_nats::jetstream::stream::Config {
            name: name.clone(),
            subjects: vec![subject.clone()],
            ..Default::default()
        })
        .await
        .unwrap();
    let mut config = Projection::Orders.config();
    config.filter_subject = subject.clone();
    let mut consumer = stream.create_consumer(config).await.unwrap();
    let publisher = js.clone();
    let publish_subject = subject.clone();
    let arrivals = tokio::spawn(async move {
        for n in 0..3 {
            tokio::time::sleep(Duration::from_millis(40)).await;
            publisher
                .publish(publish_subject.clone(), n.to_string().into())
                .await
                .unwrap()
                .await
                .unwrap();
        }
    });
    let began = tokio::time::Instant::now();
    // This is the same collection function used by the production projection loop.
    let messages = tokio::time::timeout(Duration::from_secs(3), read_batch(&consumer))
        .await
        .unwrap()
        .unwrap();
    let elapsed = began.elapsed();
    arrivals.await.unwrap();
    let values: Vec<_> = messages.iter().map(|m| m.payload.to_vec()).collect();
    assert_eq!(values, vec![b"0".to_vec(), b"1".to_vec(), b"2".to_vec()]);
    assert!(elapsed >= Duration::from_millis(150));
    let info = consumer.info().await.unwrap();
    assert_eq!(info.num_ack_pending, 3);
    assert_eq!(info.ack_floor.stream_sequence, 0);
    complete_batch(&messages, async {}, Duration::from_secs(30))
        .await
        .unwrap();

    let began = tokio::time::Instant::now();
    let empty = tokio::time::timeout(Duration::from_secs(3), read_batch(&consumer))
        .await
        .unwrap()
        .unwrap();
    assert!(empty.is_empty());
    assert!(
        began.elapsed() >= Duration::from_millis(150),
        "idle pulls must wait instead of hot-polling"
    );

    for n in 0..=BATCH_SIZE {
        js.publish(subject.clone(), n.to_string().into())
            .await
            .unwrap()
            .await
            .unwrap();
    }
    let full = tokio::time::timeout(Duration::from_secs(3), read_batch(&consumer))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(full.len(), BATCH_SIZE);
    let info = consumer.info().await.unwrap();
    assert_eq!(info.num_ack_pending, BATCH_SIZE);
    assert_eq!(info.num_pending, 1);
    complete_batch(&full, async {}, Duration::from_secs(30))
        .await
        .unwrap();
    let tail = tokio::time::timeout(Duration::from_secs(3), read_batch(&consumer))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tail.len(), 1);
    complete_batch(&tail, async {}, Duration::from_secs(30))
        .await
        .unwrap();
    let info = consumer.info().await.unwrap();
    assert_eq!(info.num_pending, 0);
    assert_eq!(info.num_ack_pending, 0);
    js.delete_stream(name).await.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable loopback NATS server via NATS_TEST_URL"]
async fn durable_upgrade_retains_cursor_unacked_work_and_heartbeats() {
    let url = std::env::var("NATS_TEST_URL").expect("NATS_TEST_URL");
    let js = async_nats::jetstream::new(async_nats::connect(url).await.unwrap());
    for projection in [Projection::Cart, Projection::Orders] {
        let name = format!("ANALYTICS_TEST_{}", Uuid::new_v4().simple());
        let subject = format!("test.{}", Uuid::new_v4().simple());
        let stream = js
            .create_stream(async_nats::jetstream::stream::Config {
                name: name.clone(),
                subjects: vec![subject.clone()],
                ..Default::default()
            })
            .await
            .unwrap();
        let mut config = projection.config();
        config.filter_subjects.clear();
        config.filter_subject = subject.clone();
        config.max_ack_pending = 1;
        config.ack_wait = Duration::from_millis(200);
        let old = stream.create_consumer(config.clone()).await.unwrap();
        for n in 0..3 {
            js.publish(subject.clone(), n.to_string().into())
                .await
                .unwrap()
                .await
                .unwrap();
        }
        let mut first = old.fetch().max_messages(1).messages().await.unwrap();
        first
            .next()
            .await
            .unwrap()
            .unwrap()
            .double_ack()
            .await
            .unwrap();
        let mut second = old.fetch().max_messages(1).messages().await.unwrap();
        let unacked = second.next().await.unwrap().unwrap();
        assert_eq!(unacked.payload.as_ref(), b"1");
        config.max_ack_pending = BATCH_SIZE as i64;
        let mut upgraded = stream.create_consumer(config).await.unwrap();
        let info = upgraded.info().await.unwrap();
        assert_eq!(info.ack_floor.stream_sequence, 1);
        assert_eq!(info.num_ack_pending, 1);
        tokio::time::sleep(Duration::from_millis(250)).await;
        let mut incoming = upgraded
            .fetch()
            .max_messages(2)
            .expires(Duration::from_secs(1))
            .messages()
            .await
            .unwrap();
        let mut messages = Vec::new();
        while let Some(message) = incoming.next().await {
            messages.push(message.unwrap());
        }
        let mut values: Vec<_> = messages.iter().map(|m| m.payload.to_vec()).collect();
        values.sort();
        assert_eq!(values, vec![b"1".to_vec(), b"2".to_vec()]);
        let (release, pending) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            complete_batch(
                &messages,
                async {
                    pending.await.unwrap();
                },
                Duration::from_millis(25),
            )
            .await
            .unwrap();
        });
        tokio::time::sleep(Duration::from_millis(450)).await;
        let info = upgraded.info().await.unwrap();
        assert_eq!(info.ack_floor.stream_sequence, 1);
        assert_eq!(info.num_ack_pending, 2);
        let mut none = upgraded
            .fetch()
            .max_messages(1)
            .expires(Duration::from_millis(100))
            .messages()
            .await
            .unwrap();
        assert!(
            none.next().await.is_none(),
            "in-flight writes must not redeliver while heartbeats succeed"
        );
        release.send(()).unwrap();
        worker.await.unwrap();
        let info = upgraded.info().await.unwrap();
        assert_eq!(info.ack_floor.stream_sequence, 3);
        assert_eq!(info.num_ack_pending, 0);
        js.delete_stream(name).await.unwrap();
    }
}
