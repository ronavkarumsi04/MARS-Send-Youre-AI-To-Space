package app

import "fmt"

func Start(path string) error {
	cfg, err := loadConfig(path)
	if err != nil {
		return err
	}
	db, err := openDatabase(cfg)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	srv, err := newServer(cfg, db)
	if err != nil {
		return err
	}
	fmt.Println("listening on", cfg.Addr)
	return srv.Run()
}
